import { BigmodelPollOAuthClient, LOGIN_TIMEOUT_MS, ZaiOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { loadCredential, saveCredential } from "../auth/store.js";
import { maskApiKey } from "../auth/account-view.js";
import { errorResponse } from "../proxy/translated-response.js";
import { hostSetInterval } from "../utils/host-timers.js";
import { appendLog } from "./logs.js";
import { ensureCaptchaPoolForStartPlan, probeStartPlanActivation } from "./quota.js";
import { readJsonBody } from "./request-body.js";
import { jsonResp } from "./security.js";
import type { AdminRouteContext } from "./types.js";

// Active OAuth flows (in-memory)
// Fork-merge note: the upstream 4.x OAuth is the SERVER-MEDIATED poll flow
// (zcode.z.ai /oauth/cli/init + /oauth/cli/poll/{flow_id}) — there is no
// localhost callback server anymore. The admin dashboard keeps its
// init → poll-status two-phase shape: `init` starts the client's complete()
// in a background task and `poll` just reads that task's status.
type ActiveOAuthFlow = { provider: string; flowId: string; pollToken: string; expiresAt: number; plan?: string; status?: string; error?: string; callbackUrl?: string; state?: string; close?: () => Promise<void> };

const MAX_ACTIVE_OAUTH_FLOWS = 100;

const OAUTH_FLOW_CLEANUP_GRACE_MS = 5 * 60_000;

const activeFlows = new Map<string, ActiveOAuthFlow>();

function closeActiveOAuthFlow(flow: ActiveOAuthFlow): void {
  const close = flow.close;
  if (!close) return;
  void close().catch((err) => {
    appendLog("debug", `OAuth flow ${flow.flowId} close failed: ${(err as Error).message}`);
  });
}

function deleteActiveOAuthFlow(flowId: string): boolean {
  const flow = activeFlows.get(flowId);
  if (!flow) return false;
  activeFlows.delete(flowId);
  closeActiveOAuthFlow(flow);
  return true;
}

function pruneActiveOAuthFlows(now = Date.now()): number {
  let cleaned = 0;
  for (const [id, flow] of activeFlows) {
    if (now > flow.expiresAt + OAUTH_FLOW_CLEANUP_GRACE_MS) {
      activeFlows.delete(id);
      closeActiveOAuthFlow(flow);
      cleaned++;
    }
  }
  while (activeFlows.size > MAX_ACTIVE_OAUTH_FLOWS) {
    const oldest = activeFlows.keys().next().value;
    if (oldest === undefined) break;
    deleteActiveOAuthFlow(oldest);
    cleaned++;
  }
  return cleaned;
}

function rememberActiveOAuthFlow(flowId: string, flow: ActiveOAuthFlow): void {
  pruneActiveOAuthFlows();
  deleteActiveOAuthFlow(flowId);
  activeFlows.set(flowId, flow);
  pruneActiveOAuthFlows();
}

export function _resetActiveOAuthFlowsForTesting(): void {
  for (const flow of activeFlows.values()) closeActiveOAuthFlow(flow);
  activeFlows.clear();
}

export function _activeOAuthFlowCountForTesting(): number {
  return activeFlows.size;
}

export function _hasActiveOAuthFlowForTesting(flowId: string): boolean {
  return activeFlows.has(flowId);
}

export function _rememberActiveOAuthFlowForTesting(
  flowId: string,
  expiresAt = Date.now() + 300_000,
  close?: () => Promise<void>,
): void {
  rememberActiveOAuthFlow(flowId, {
    provider: "zai",
    flowId,
    pollToken: flowId,
    expiresAt,
    close,
  });
}

/**
 * Periodic cleanup of expired OAuth flows. Without this, abandoned flows
 * (user closed the browser without finishing auth) would accumulate in
 * memory forever — each one carries the pollToken and callbackUrl, both
 * sensitive-ish. Runs every 5 minutes; flows expire 5 minutes after their
 * expiresAt timestamp to give in-flight poll requests a chance to drain.
 */
hostSetInterval(() => {
  const cleaned = pruneActiveOAuthFlows();
  if (cleaned > 0) {
    appendLog("debug", `OAuth flow cleanup: removed ${cleaned} expired flow(s)`);
  }
}, 5 * 60_000).unref?.();

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleOauthRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, url, path, method } = context;

  // OAuth init — fork-merge: rewritten for the upstream 4.x server-mediated
  // poll flow. Both providers use `ZaiOAuthClient` / `BigmodelPollOAuthClient`
  // (zcode.z.ai /oauth/cli/init + /oauth/cli/poll/{flow_id}); there is no
  // localhost callback server on this path anymore. The dashboard contract is
  // unchanged: POST init → { flowId, authorizeUrl } then GET poll?flowId=…
  // until ready/failed/expired. The client's blocking complete() runs in a
  // background task and only mutates that task's status — the poll endpoint
  // stays non-blocking.
  if (path === "/admin/api/oauth/init" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider?: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider;
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const oauthPlan = (body.plan ?? "coding-plan") as "coding-plan" | "start-plan";

      // Server-mediated poll login (ZCode 3.12.3+ default): open the returned
      // authorize URL on ANY device — the flow completes server-side while the
      // background task polls.
      const oauth = provider === "bigmodel" ? new BigmodelPollOAuthClient() : new ZaiOAuthClient();
      const started = await oauth.start();
      const flowId = `${provider}_${started.state.slice(0, 16)}`;
      const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
      rememberActiveOAuthFlow(flowId, {
        provider,
        flowId,
        pollToken: started.state,
        expiresAt,
        state: started.state,
        plan: oauthPlan,
        status: "pending",
        close: () => oauth.close(),
      });

      // Background completion: poll the server until ready, resolve the
      // credential, save it as a NEW account (never stealing the active slot),
      // then probe start-plan activation + lazy-start the captcha pool.
      (async () => {
        try {
          const tokens = await oauth.complete(started, LOGIN_TIMEOUT_MS);
          const { accessToken, userId, jwt, email } = tokens;
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCredential(accessToken, provider, userId, oauthPlan, jwt, email);
          // Auto-generate name from email + plan (vceshi0.0.4+).
          if (email) {
            cred.name = `${email}-${oauthPlan}`;
          }
          // keepActive:true — do NOT silently swap the user's currently-active
          // credential out from under them. The new account appears in the
          // dashboard list; the user explicitly clicks "Activate" to switch.
          await saveCredential(cred, { keepActive: true });
          // Hot-swap the in-memory credential ONLY IF there was no active
          // credential before this OAuth flow completed.
          const existingActive = await loadCredential();
          if (existingActive && existingActive.apiKey === cred.apiKey) {
            opts.auth.setOAuthCredential(existingActive);
          }
          // Probe start-plan activation in the background (fire-and-forget).
          probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion, opts.config.identity);
          // Fresh installs defer the captcha pre-solver until the first
          // credential exists (see index.ts). Start it now — fire-and-forget.
          void ensureCaptchaPoolForStartPlan(cred, opts.config.identity?.appVersion);
          const flow = activeFlows.get(flowId);
          if (flow) { flow.status = "ready"; }
          appendLog("info", `OAuth login succeeded: ${provider} ${oauthPlan} (${maskApiKey(cred.apiKey)})`);
        } catch (err) {
          const flow = activeFlows.get(flowId);
          if (flow) { flow.status = "failed"; flow.error = (err as Error).message; }
          appendLog("debug", `${provider} OAuth flow ${flowId} failed: ${(err as Error).message}`);
        } finally {
          // ALWAYS close the flow (poll client holds no server socket, but
          // close() is part of the lifecycle contract and test seams rely on it).
          try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
        }
      })();
      return jsonResp({ flowId, authorizeUrl: started.authorizeUrl, expiresAt });
    } catch (err) {
      return errorResponse(500, "oauth_init_failed", (err as Error).message);
    }
  }

  // OAuth poll
  if (path === "/admin/api/oauth/poll" && method === "GET") {
    const flowId = url.searchParams.get("flowId");
    if (!flowId) return errorResponse(400, "missing_param", "flowId required");
    const flow = activeFlows.get(flowId);
    if (!flow) return errorResponse(404, "not_found", "Unknown flow");
    // Check expiry (vceshi0.0.5+): expired flows return "expired" status so the
    // dashboard can show a clear "授权已过期" message instead of spinning forever.
    if (Date.now() > flow.expiresAt) {
      deleteActiveOAuthFlow(flowId);
      return jsonResp({ status: "expired" });
    }
    const status = (flow as any).status || "pending";
    const resp: any = { status };
    // Surface the error message on failure (vceshi0.0.5+) — previously the
    // dashboard couldn't tell the user WHY the flow failed.
    if (status === "failed" && (flow as any).error) {
      resp.error = (flow as any).error;
    }
    if (status === "ready" || status === "failed") deleteActiveOAuthFlow(flowId);
    return jsonResp(resp);
  }

  // OAuth manual callback URL submission — RETIRED by the fork-merge.
  //
  // The fork-era flow used a localhost callback server: the user pasted the
  // redirected `?code=&state=` URL and the proxy exchanged it. Upstream 4.x
  // replaced that with the server-mediated poll flow — the browser never
  // calls back, the login completes while the dashboard polls `oauth/poll`,
  // and there is no authorization code to paste. The endpoint stays (the
  // dashboard still has the card) and explains the new behavior instead of
  // 404-ing, so older frontends degrade gracefully.
  if (path === "/admin/api/oauth/callback" && method === "POST") {
    return errorResponse(
      410,
      "oauth_callback_retired",
      "Manual callback exchange is no longer needed: login now uses the server-mediated " +
      "poll flow. Open the authorize URL on any device — this page completes the login " +
      "automatically once you approve access.",
    );
  }
  return null;
}
