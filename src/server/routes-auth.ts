/**
 * OAuth route handlers: /auth/login, /auth/status.
 * @see .omo/plans/zcode-proxy.md Task 9
 */
import type { AuthManager } from "../auth/manager.js";
import { ZaiOAuthClient, type OAuthInitResponse } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { errorResponse } from "../proxy/handler.js";

export interface AuthRouteState {
  auth: AuthManager;
  oauth: ZaiOAuthClient;
  resolver: KeyResolver;
  activeFlows: Map<string, OAuthInitResponse>;
}

export function createAuthRoutes(state: AuthRouteState) {
  return {
    async handleLogin(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const provider = (url.searchParams.get("provider") ?? "zai") as "zai" | "bigmodel";

      try {
        const init = await state.oauth.init(provider);
        state.activeFlows.set(init.flowId, init);

        return new Response(
          JSON.stringify({
            flowId: init.flowId,
            authorizeUrl: init.authorizeUrl,
            expiresIn: Math.floor((init.expiresAt - Date.now()) / 1000),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        return errorResponse(500, "oauth_init_failed", (err as Error).message);
      }
    },

    async handleStatus(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const flowId = url.searchParams.get("flow_id");

      if (!flowId) {
        return errorResponse(400, "missing_param", "flow_id is required");
      }

      const init = state.activeFlows.get(flowId);
      if (!init) {
        return errorResponse(404, "flow_not_found", "Unknown or expired flow");
      }

      try {
        const pollResult = await state.oauth.poll(init.flowId, init.pollToken);

        if (pollResult.status === "ready" && pollResult.zai?.access_token) {
          const cred = await state.resolver.resolveCodingPlanCredential(
            pollResult.zai.access_token,
            "zai",
          );
          state.auth.setOAuthCredential(cred);
          state.activeFlows.delete(flowId);

          return new Response(
            JSON.stringify({ status: "complete", provider: "zai" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ status: pollResult.status }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        return errorResponse(500, "oauth_resolution_failed", (err as Error).message);
      }
    },
  };
}
