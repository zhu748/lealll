import type { Credential, PlanId } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import type { FetchFn } from "./oauth.js";
// v0.3.7.1: host-captured timers — auth flows (credential rotation
// during retries, OAuth, quota probes) run concurrent with captcha solve
// epochs; bare globals resolve through the solver window alias there and are
// cancelled on window destruction. See utils/host-timers.ts.
import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";

const ZAI_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "\u9ED8\u8BA4\u673A\u6784"; // 默认机构
const DEFAULT_PROJECT_MARKER = "\u9ED8\u8BA4\u9879\u76EE"; // 默认项目
const DEFAULT_BIZ_API_TIMEOUT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_BIZ_JSON_BYTES = 2 * 1024 * 1024;

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

async function readJsonLimited(
  resp: Response,
  maxBytes = MAX_BIZ_JSON_BYTES,
  timeoutMs = DEFAULT_BIZ_API_TIMEOUT_MS,
): Promise<any> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = parseContentLength(resp.headers);
  if (declaredLength !== undefined && declaredLength > limit) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`Biz API JSON response exceeds ${limit} byte limit (content-length ${declaredLength})`);
  }
  if (!resp.body) return {};

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
        throw new Error(`Biz API JSON response exceeds ${limit} byte limit`);
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
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : {};
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  const timeout = normalizeTimerMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    reader.read(),
    new Promise<"timeout">(resolve => {
      timer = hostSetTimeout(() => resolve("timeout"), timeout);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      hostClearTimeout(timer);
      timer = null;
    }
  });
  if (result === "timeout") {
    const err = new Error(`Biz API JSON response read timeout after ${timeout}ms`);
    void reader.cancel(err).catch(() => {});
    throw err;
  }
  return result;
}

async function fetchWithTimeout(
  fetchImpl: FetchFn,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timeout = normalizeTimerMs(timeoutMs);
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
  const timer = hostSetTimeout(() => ctrl.abort(), timeout);
  timer.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted && !upstreamAborted) {
      throw new Error(`Biz API request timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    hostClearTimeout(timer);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
  }
}

function normalizeTimerMs(raw: number, fallback = DEFAULT_BIZ_API_TIMEOUT_MS): number {
  const candidate = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const safe = Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_BIZ_API_TIMEOUT_MS;
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(safe)));
}

async function requestBizApi(
  fetchImpl: FetchFn,
  url: string,
  authorization: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_BIZ_API_TIMEOUT_MS,
): Promise<any> {
  const resp = await fetchWithTimeout(fetchImpl, url, {
    ...init,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  }, timeoutMs);
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`Biz API ${url} failed: ${resp.status}`);
  }
  const body = await readJsonLimited(resp, MAX_BIZ_JSON_BYTES, timeoutMs);
  const code = body.code ?? body.status;
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new Error(body.msg ?? `Biz API error ${code}`);
  }
  return body.data ?? body;
}

export class KeyResolver {
  constructor(
    private fetchImpl: FetchFn = fetch,
    private requestTimeoutMs: number = DEFAULT_BIZ_API_TIMEOUT_MS,
  ) {}

  async resolveZaiBizToken(accessToken: string): Promise<string> {
    const resp = await fetchWithTimeout(this.fetchImpl, "https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
    }, this.requestTimeoutMs);
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {});
      throw new Error(`z/login failed: ${resp.status}`);
    }
    const data = await readJsonLimited(resp, MAX_BIZ_JSON_BYTES, this.requestTimeoutMs);
    const token = data.access_token ?? data.accessToken ?? data.data?.access_token;
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("z/login response missing access_token");
    }
    return token.trim();
  }

  async resolveCustomerInfo(
    host: string,
    authorization: string,
  ): Promise<{ orgId: string; projectId: string }> {
    const data = await requestBizApi(
      this.fetchImpl,
      `${host}/api/biz/customer/getCustomerInfo`,
      authorization,
      { method: "GET" },
      this.requestTimeoutMs,
    );

    const orgs: any[] = data.organizations ?? data.orgs ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("No organizations found");
    }
    const org = orgs.find((o) =>
      (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER),
    ) ?? orgs[0];
    const orgId = org.organizationId ?? org.id ?? org.orgId;

    const projects: any[] = org.projects ?? [];
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error("No projects found in default organization");
    }
    const project = projects.find((p) =>
      (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER),
    ) ?? projects[0];
    const projectId = project.projectId ?? project.id;

    return { orgId, projectId };
  }

  async findOrCreateApiKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
  ): Promise<{ apiKey: string }> {
    const listUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;

    let existing: any[] = [];
    try {
      existing = await requestBizApi(this.fetchImpl, listUrl, authorization, { method: "GET" }, this.requestTimeoutMs) ?? [];
    } catch { /* ignore — will create */ }

    if (Array.isArray(existing)) {
      const found = existing.find((k: any) => k.name === ZAI_API_KEY_NAME);
      if (found?.apiKey) {
        return { apiKey: found.apiKey };
      }
    }

    const created = await requestBizApi(this.fetchImpl, listUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    }, this.requestTimeoutMs);
    return { apiKey: created.apiKey };
  }

  async getSecretKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
    apiKey: string,
  ): Promise<string> {
    const url = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`;
    const data = await requestBizApi(this.fetchImpl, url, authorization, { method: "GET" }, this.requestTimeoutMs);
    return data.secretKey ?? data.secret_key ?? "";
  }

  async resolveCodingPlanCredential(
    accessToken: string,
    provider: ProviderId,
    userId?: string,
    plan: PlanId = "coding-plan",
    email?: string,
  ): Promise<Credential> {
    if (provider === "zai") {
      let bizToken = accessToken;
      try {
        // OAuth responses from zcode.z.ai still carry a raw ZAI access token,
        // but ZCode 3.2.5 stores oauth:zai:access_token after it has already
        // been exchanged through /api/auth/z/login. Tolerate both shapes.
        bizToken = await this.resolveZaiBizToken(accessToken);
      } catch {
        bizToken = accessToken;
      }
      const host = "https://api.z.ai";
      const authorization = `Bearer ${bizToken}`;

      const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
      const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);
      let secret: string | undefined;
      try {
        secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      } catch { /* credential will be apiKey-only */ }

      const cred: Credential = { apiKey, secret: secret || undefined, provider: "zai", plan, userId };
      if (email) cred.email = email;
      return cred;
    }

    const host = "https://bigmodel.cn";
    const authorization = accessToken;

    const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
    const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);

    let fullKey = apiKey;
    try {
      const secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      if (secret) fullKey = `${apiKey}.${secret}`;
    } catch { /* use apiKey only */ }

    const cred: Credential = { apiKey: fullKey, provider: "bigmodel", plan, userId };
    if (email) cred.email = email;
    return cred;
  }

  /**
   * Resolve a credential with a start-plan graceful fallback.
   *
   * For **coding-plan**, the biz-API exchange is mandatory — there is no
   * alternative credential, so any failure propagates (throws).
   *
   * For **start-plan**, the actual upstream credential is the ZCode plan JWT
   * (sent as `Authorization: Bearer {jwt}` via zcode.z.ai — see
   * src/proxy/upstream.ts buildAuthHeaders). The biz-API `apiKey`/`secret` are
   * only decorative for start-plan, so if the biz exchange fails (e.g. the
   * 1-hour `zai.access_token` already expired, or the account has no biz
   * profile), we MUST NOT lose the whole login. Instead, fall back to a
   * start-plan credential whose `apiKey` mirrors the JWT (matching
   * importFromZCodeConfig's start-plan shape), so the credential still saves
   * and works.
   *
   * `jwt` is attached to the result whenever present (both paths).
   */
  async resolveCredential(
    accessToken: string,
    provider: ProviderId,
    userId: string | undefined,
    plan: PlanId,
    jwt?: string,
    email?: string,
  ): Promise<Credential> {
    // coding-plan: no fallback — biz API is the only credential source.
    if (plan !== "start-plan") {
      const cred = await this.resolveCodingPlanCredential(accessToken, provider, userId, plan, email);
      if (jwt) cred.jwt = jwt;
      return cred;
    }

    // start-plan: try biz API for the decorative apiKey/secret, but tolerate
    // failure by falling back to a JWT-only credential.
    try {
      const cred = await this.resolveCodingPlanCredential(accessToken, provider, userId, plan, email);
      if (jwt) cred.jwt = jwt;
      return cred;
    } catch (err) {
      if (!jwt) {
        // Nothing to fall back to — propagate so the caller surfaces the error
        // instead of silently storing an empty credential.
        throw err;
      }
      console.warn(
        `[resolver] start-plan biz-API exchange failed (${(err as Error).message}); ` +
        `falling back to JWT-only start-plan credential.`,
      );
      const cred: Credential = {
        apiKey: jwt,
        provider,
        plan: "start-plan",
        jwt,
        userId,
      };
      if (email) cred.email = email;
      return cred;
    }
  }
}
