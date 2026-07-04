/**
 * OAuth flow handlers for Z.AI and Bigmodel.
 *
 * Both providers use the SAME auth-code/callback pattern, proxied through
 * zcode.z.ai so the appSecret stays server-side:
 *
 *   1. Start a localhost HTTP server on a random port
 *   2. Build an authorize URL the user opens in a real browser
 *   3. The provider redirects to the localhost callback with ?code=&state=
 *   4. POST https://zcode.z.ai/api/v1/oauth/token {provider, code, redirect_uri, state}
 *   5. zcode.z.ai exchanges using its own appSecret and returns the tokens
 *
 * For Z.AI this loop is what activates the start-plan trial on a fresh
 * account (verified end-to-end against the real backend). The old device/poll
 * flow against /oauth/cli/init + /oauth/cli/poll was the wrong protocol and
 * never worked — it has been removed.
 *
 * @see .omo/plans/zcode-proxy.md Task 9
 * @see _reverse/NOTEPAD.md "Method 1: OAuth Flow"
 * @see test-zai-oauth.cjs for the standalone replication that proved the loop.
 */
import type { ProviderId } from "../provider/types.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
// IncomingMessage and ServerResponse are used by the CallbackServer class below.
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from ZCode bundle)
// ---------------------------------------------------------------------------

const ZCODE_OAUTH_BASE = "https://zcode.z.ai/api/v1";

// Z.AI (zai) OAuth — authorize lives on chat.z.ai, exchange is proxied
// through zcode.z.ai. client_id is the public app id from the bundle.
const ZAI_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const ZAI_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const ZAI_CALLBACK_PATH = "/oauth/callback/zai";

// Bigmodel OAuth — authorize lives on bigmodel.cn, exchange is proxied
// through zcode.z.ai. appId is the public app id from the bundle.
const BIGMODEL_HOST = "https://bigmodel.cn";
const BIGMODEL_APP_ID = "zcode";
const BIGMODEL_CALLBACK_PATH = "/oauth/callback/bigmodel";
const DEFAULT_OAUTH_TOKEN_TIMEOUT_MS = 30_000;
const MAX_OAUTH_JSON_BYTES = 2 * 1024 * 1024;
const CALLBACK_CLOSE_TIMEOUT_MS = 250;
const DEFAULT_CALLBACK_WAIT_TIMEOUT_MS = 300_000;
const MIN_CALLBACK_WAIT_TIMEOUT_MS = 1;
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Result of starting a localhost OAuth callback server.
 *
 * `flowId` / `pollToken` are kept as aliases for the callback `state` so the
 * admin flow-tracker (which keys flows by flowId and stores pollToken) keeps
 * working without churn — under the auth-code model the `state` doubles as
 * both the CSRF guard and the flow identity.
 */
export interface OAuthInitResponse {
  flowId: string;
  pollToken: string;
  authorizeUrl: string;
  /** Absolute deadline (ms epoch) after which the flow is considered expired. */
  expiresAt: number;
  /** Localhost callback URL registered with the provider (the redirect_uri). */
  callbackUrl: string;
  /** CSRF state echoed back by the provider on the callback. */
  state: string;
}

export interface OAuthResult {
  accessToken: string;
  provider: ProviderId;
  /** Upstream user identifier, when the OAuth response included one. Passed through to `metadata.user_id` on Anthropic-format requests. */
  userId?: string;
  /** ZCode plan JWT for start-plan (zcode.z.ai). The OAuth poll/exchange response includes this alongside the provider access_token. */
  jwt?: string;
  /** User email captured from the OAuth callback response (`data.user.email`).
   *  Used to auto-generate the credential name as `{email}-{plan}`. Optional
   *  because some OAuth responses (or older versions) don't include it. */
  email?: string;
}

export function normalizeCallbackWaitTimeoutMs(timeoutMs: number = DEFAULT_CALLBACK_WAIT_TIMEOUT_MS): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_CALLBACK_WAIT_TIMEOUT_MS;
  const n = Math.floor(timeoutMs);
  if (n < MIN_CALLBACK_WAIT_TIMEOUT_MS) return MIN_CALLBACK_WAIT_TIMEOUT_MS;
  return Math.min(n, DEFAULT_CALLBACK_WAIT_TIMEOUT_MS);
}

export type FetchFn = typeof fetch;

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  const timeout = normalizeTokenRequestTimeoutMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    reader.read(),
    new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), timeout);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  if (result === "timeout") {
    const err = new Error(`OAuth token response read timeout after ${timeout}ms`);
    void reader.cancel(err).catch(() => {});
    throw err;
  }
  return result;
}

async function readTextLimited(
  resp: Response,
  maxBytes = MAX_OAUTH_JSON_BYTES,
  timeoutMs = DEFAULT_OAUTH_TOKEN_TIMEOUT_MS,
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = parseContentLength(resp.headers);
  if (declaredLength !== undefined && declaredLength > limit) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`OAuth token response exceeds ${limit} byte limit (content-length ${declaredLength})`);
  }
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunkWithTimeout(reader, timeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new Error(`OAuth token response exceeds ${limit} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWithTimeout(
  fetchImpl: FetchFn,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timeout = normalizeTokenRequestTimeoutMs(timeoutMs);
  const ctrl = new AbortController();
  const upstreamSignal = init?.signal;
  let upstreamAborted = false;
  const onUpstreamAbort = () => {
    upstreamAborted = true;
    ctrl.abort();
  };
  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeout);
  timer.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted && !upstreamAborted) {
      throw new Error(`OAuth token request timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
  }
}

function normalizeTokenRequestTimeoutMs(raw: number, fallback = DEFAULT_OAUTH_TOKEN_TIMEOUT_MS): number {
  const candidate = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const safe = Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_OAUTH_TOKEN_TIMEOUT_MS;
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(safe)));
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Z.AI / zcode.z.ai {code, data, msg} response envelope. code:0 = success. */
interface ZaiEnvelope {
  code: number;
  data?: Record<string, unknown>;
  msg?: string;
}

// ---------------------------------------------------------------------------
// Shared localhost callback server (used by both Z.AI and Bigmodel OAuth flows)
// ---------------------------------------------------------------------------

/**
 * A tiny OAuth callback receiver. Listens on 127.0.0.1, captures the first
 * `code` + matching `state`, and resolves a waiter promise. Both providers
 * redirect back to this server with `?code=&state=` after the user authorizes
 * in their browser.
 */
class CallbackServer {
  readonly state: string;
  /** Localhost callback URL; finalized in listen() once the ephemeral port is bound. */
  callbackUrl: string;
  private server: Server;
  private sockets = new Set<Socket>();
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private callbackResult: { code: string; error: string | null } | null = null;
  private callbackWaiters: Array<(result: { code: string; error: string | null }) => void> = [];

  constructor(
    callbackPath: string,
    expectedState: string,
    onSuccessHtml: string,
    onErrorHtml: (reason: string) => string,
  ) {
    this.state = expectedState;
    this.callbackUrl = `http://127.0.0.1:0${callbackPath}`; // placeholder port, fixed by listen()
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";
      const cbError = url.searchParams.get("error");

      if (cbError) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(onErrorHtml(cbError));
        this.resolveOnce({ code: "", error: `Provider returned error: ${cbError}` });
        return;
      }
      if (state !== expectedState || !code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(onErrorHtml("state mismatch or missing code"));
        this.resolveOnce({ code: "", error: "OAuth callback state mismatch or missing code." });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(onSuccessHtml);
      this.resolveOnce({ code, error: null });
    });
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      if (this.closing) socket.destroy();
    });
  }

  private resolveOnce(result: { code: string; error: string | null }): void {
    if (this.callbackResult) return;
    this.callbackResult = result;
    const waiters = this.callbackWaiters.splice(0);
    waiters.forEach((fn) => fn(result));
  }

  /** Listen on an ephemeral port and resolve with the chosen callback URL. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      // v0.2.0.8: cap concurrent connections to the localhost callback
      // server. The OAuth flow only needs ONE callback (the browser redirect
      // after the user authorizes), so any additional connection is either a
      // retry, a probe, or a localhost attacker trying to exhaust file
      // descriptors. maxConnections=5 is generous enough to tolerate browser
      // favicon/two-redirect bursts while still bounding resource use.
      this.server.maxConnections = 5;
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (!addr || typeof addr !== "object") {
          reject(new Error("Failed to bind localhost callback server"));
          return;
        }
        const callbackPath = new URL(this.callbackUrl).pathname;
        this.callbackUrl = `http://127.0.0.1:${addr.port}${callbackPath}`;
        resolve();
      });
    });
  }

  async waitForCallback(timeoutMs: number = DEFAULT_CALLBACK_WAIT_TIMEOUT_MS): Promise<string> {
    if (this.callbackResult?.code) return this.callbackResult.code;
    if (this.callbackResult?.error) throw new Error(this.callbackResult.error);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let waiter: ((result: { code: string; error: string | null }) => void) | null = null;
      const cleanup = () => {
        if (waiter) {
          const idx = this.callbackWaiters.indexOf(waiter);
          if (idx >= 0) this.callbackWaiters.splice(idx, 1);
          waiter = null;
        }
      };
      const timeout = normalizeCallbackWaitTimeoutMs(timeoutMs);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Authorization timed out. Please retry login."));
      }, timeout);
      timer.unref?.();
      waiter = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (result.error) reject(new Error(result.error));
        else resolve(result.code);
      };
      this.callbackWaiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.resolveOnce({ code: "", error: "OAuth callback server closed." });
    this.closePromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (err?: Error & { code?: string }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
          forceClose();
          reject(err);
        } else {
          forceClose();
          resolve();
        }
      };
      const forceClose = () => {
        for (const socket of this.sockets) {
          try { socket.destroy(); } catch {}
        }
        try { (this.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.(); } catch {}
        try { (this.server as Server & { closeIdleConnections?: () => void }).closeIdleConnections?.(); } catch {}
      };
      timer = setTimeout(() => {
        forceClose();
        finish();
      }, CALLBACK_CLOSE_TIMEOUT_MS);
      timer.unref?.();
      try {
        forceClose();
        this.server.close((err?: Error) => finish(err as Error & { code?: string } | undefined));
      } catch (err) {
        finish(err as Error & { code?: string });
      }
    }).finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }
}

// ---------------------------------------------------------------------------
// Z.AI OAuth — auth-code/callback flow (verified end-to-end)
// ---------------------------------------------------------------------------

/**
 * Z.AI OAuth client.
 *
 * Flow (mirrors the ZCode desktop client's zai login, replicated in
 * test-zai-oauth.cjs):
 *   1. Start localhost HTTP server on a random port
 *   2. Build authorize URL: chat.z.ai/api/oauth/authorize
 *        ?redirect_uri={localhost}&response_type=code&client_id={...}&state={state}
 *   3. User opens URL, logs in & authorizes on chat.z.ai
 *   4. chat.z.ai redirects to localhost callback with ?code=...&state=...
 *   5. POST https://zcode.z.ai/api/v1/oauth/token
 *        body: {provider:"zai", code, redirect_uri, state}
 *      (zcode.z.ai holds the appSecret and performs the real exchange)
 *   6. Returns {code:0, data:{token, zai:{access_token}, user:{user_id}}}
 *
 * The POST in step 5 is what activates the start-plan trial server-side on a
 * fresh account. Extract `zai.access_token` for credential resolution; `token`
 * is the zcode plan JWT.
 */
export class ZaiOAuthClient {
  private cb: CallbackServer | null = null;

  constructor(
    private fetchImpl: FetchFn = fetch,
    private authorizeUrl: string = ZAI_AUTHORIZE_URL,
    private clientId: string = ZAI_CLIENT_ID,
    private requestTimeoutMs: number = DEFAULT_OAUTH_TOKEN_TIMEOUT_MS,
  ) {}

  /**
   * Start the localhost callback server and build the authorize URL.
   * Call waitForCallback() / exchangeCode() afterwards, then close().
   */
  async start(): Promise<OAuthInitResponse> {
    const state = randomBytes(32).toString("hex");
    this.cb = new CallbackServer(
      ZAI_CALLBACK_PATH,
      state,
      "<h1>授权成功,可以关闭此页面。</h1>",
      (reason) => `<h1>授权失败</h1><p>${reason}</p>`,
    );
    await this.cb.listen();

    const params = new URLSearchParams({
      redirect_uri: this.cb.callbackUrl,
      response_type: "code",
      client_id: this.clientId,
      state,
    });
    const authorizeUrl = `${this.authorizeUrl}?${params.toString()}`;

    return {
      flowId: state,
      pollToken: state,
      authorizeUrl,
      expiresAt: Date.now() + 300_000,
      callbackUrl: this.cb.callbackUrl,
      state,
    };
  }

  /** Wait for the OAuth callback redirect. Resolves with the auth code. */
  async waitForCallback(timeoutMs: number = 300_000): Promise<string> {
    if (!this.cb) throw new Error("OAuth server not started — call start() first");
    return this.cb.waitForCallback(timeoutMs);
  }

  /**
   * Exchange the auth code via zcode.z.ai proxy.
   * The ZCode server holds the appSecret and performs the real Z.AI exchange.
   * Returns the zai access_token (for credential resolution), the plan JWT,
   * and the upstream user id.
   */
  async exchangeCode(
    authCode: string,
    redirectUri: string,
    state: string,
  ): Promise<{ accessToken: string; userId?: string; jwt?: string; email?: string }> {
    const resp = await fetchWithTimeout(this.fetchImpl, `${ZCODE_OAUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "zai",
        code: authCode,
        redirect_uri: redirectUri,
        state,
      }),
    }, this.requestTimeoutMs);

    const raw = safeJsonParse(await readTextLimited(resp, MAX_OAUTH_JSON_BYTES, this.requestTimeoutMs)) as ZaiEnvelope & {
      data?: {
        token?: string;
        user?: { user_id?: string; email?: string };
        email?: string;
        zai?: { access_token?: string };
      };
    } | null;

    if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
      throw new Error(
        `Z.AI token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`,
      );
    }

    const accessToken = raw?.data?.zai?.access_token?.trim() ?? "";
    if (!accessToken) {
      throw new Error("Z.AI token response missing zai.access_token");
    }
    const userId = raw?.data?.user?.user_id;
    const jwt = raw?.data?.token?.trim() ?? undefined;
    const email = raw?.data?.user?.email ?? raw?.data?.email;
    return {
      accessToken,
      userId: typeof userId === "string" ? userId : undefined,
      jwt,
      email: typeof email === "string" ? email.trim() || undefined : undefined,
    };
  }

  /** Run the full Z.AI OAuth flow: start → wait → exchange. Closes the server on exit. */
  async authorize(
    onAuthorizeUrl?: (url: string) => void,
    timeoutMs: number = 300_000,
  ): Promise<OAuthResult> {
    const init = await this.start();
    onAuthorizeUrl?.(init.authorizeUrl);
    try {
      const authCode = await this.waitForCallback(timeoutMs);
      const { accessToken, userId, jwt, email } = await this.exchangeCode(authCode, init.callbackUrl, init.state);
      return { accessToken, provider: "zai", userId, jwt, email };
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.cb) {
      await this.cb.close();
      this.cb = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Bigmodel OAuth — via zcode.z.ai proxy (Electron host process flow)
// ---------------------------------------------------------------------------

const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";

/**
 * Bigmodel OAuth client.
 *
 * The ZCode Electron app proxies the Bigmodel OAuth token exchange through
 * zcode.z.ai so the appSecret stays server-side. We replicate that flow:
 *
 *   1. Start localhost HTTP server on random port
 *   2. Build authorize URL: bigmodel.cn/login?appId=zcode&redirect={localhost}&state={state}
 *   3. User opens URL, authorizes on bigmodel.cn
 *   4. Bigmodel redirects to localhost callback with ?code=...&state=...
 *   5. POST https://zcode.z.ai/api/v1/oauth/token
 *      body: {provider:"bigmodel", code, redirect_uri, state}
 *   6. zcode.z.ai server uses its own appSecret to exchange with Bigmodel
 *   7. Returns access_token
 *
 * @see ~/.zcode/v2/logs — [bigmodelOAuth] zcode token request
 */
export class BigmodelOAuthClient {
  private cb: CallbackServer | null = null;

  constructor(
    private fetchImpl: FetchFn = fetch,
    private host: string = BIGMODEL_HOST,
    private appId: string = BIGMODEL_APP_ID,
    private requestTimeoutMs: number = DEFAULT_OAUTH_TOKEN_TIMEOUT_MS,
  ) {}

  /**
   * Run the full Bigmodel OAuth flow: start callback server, return authorize URL.
   * Call waitForCallback() afterwards, then close().
   */
  async start(): Promise<{ authorizeUrl: string; callbackUrl: string; state: string }> {
    const state = randomBytes(32).toString("hex");
    this.cb = new CallbackServer(
      BIGMODEL_CALLBACK_PATH,
      state,
      "Authorization successful! You may close this window and return to the CLI.",
      (reason) => `Authorization failed: ${reason}`,
    );
    await this.cb.listen();

    const params = new URLSearchParams({
      appId: this.appId,
      redirect: this.cb.callbackUrl,
      state,
    });
    const authorizeUrl = `${this.host}/login?${params.toString()}`;

    return { authorizeUrl, callbackUrl: this.cb.callbackUrl, state };
  }

  /** Wait for the OAuth callback redirect. Resolves with authCode. */
  async waitForCallback(timeoutMs: number = 300_000): Promise<string> {
    if (!this.cb) throw new Error("OAuth server not started — call start() first");
    return this.cb.waitForCallback(timeoutMs);
  }

  /**
   * Exchange auth code via zcode.z.ai proxy.
   * The ZCode server holds the appSecret and performs the real Bigmodel exchange.
   * Returns `{ accessToken, userId }` — userId is captured from the response's
   * `data.user.user_id` when present.
   */
  async exchangeCode(
    authCode: string,
    redirectUri: string,
    state: string,
  ): Promise<{ accessToken: string; userId?: string; jwt?: string; email?: string }> {
    const resp = await fetchWithTimeout(this.fetchImpl, ZCODE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "bigmodel",
        code: authCode,
        redirect_uri: redirectUri,
        state,
      }),
    }, this.requestTimeoutMs);

    const raw = safeJsonParse(await readTextLimited(resp, MAX_OAUTH_JSON_BYTES, this.requestTimeoutMs)) as {
      code?: number;
      data?: {
        token?: string;
        user?: { user_id?: string; email?: string };
        email?: string;
        bigmodel?: { access_token?: string };
      };
      msg?: string;
    } | null;

    if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
      throw new Error(
        `Bigmodel token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`,
      );
    }

    const accessToken = raw?.data?.bigmodel?.access_token?.trim() ?? "";

    if (!accessToken) {
      throw new Error("Bigmodel token response missing bigmodel.access_token");
    }
    const userId = raw?.data?.user?.user_id;
    const jwt = raw?.data?.token?.trim() ?? undefined;
    const email = raw?.data?.user?.email ?? raw?.data?.email;
    return {
      accessToken,
      userId: typeof userId === "string" ? userId : undefined,
      jwt,
      email: typeof email === "string" ? email.trim() || undefined : undefined,
    };
  }

  async authorize(
    onAuthorizeUrl?: (url: string) => void,
    timeoutMs: number = 300_000,
  ): Promise<OAuthResult> {
    const { authorizeUrl, callbackUrl, state } = await this.start();
    onAuthorizeUrl?.(authorizeUrl);

    try {
      const authCode = await this.waitForCallback(timeoutMs);
      const { accessToken, userId, jwt, email } = await this.exchangeCode(authCode, callbackUrl, state);
      return { accessToken, provider: "bigmodel", userId, jwt, email };
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.cb) {
      await this.cb.close();
      this.cb = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
