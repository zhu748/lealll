import { defaultPromptRewriteConfig } from "../../config/prompt-rewrite.js";
import { clearPromptObservation, latestPromptObservation } from "../../proxy/prompt-observation.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";

/** Prompt diagnostics share the dashboard's authentication and same-origin gates. */
export function handlePromptRewriteRoutes({ opts, path, method }: AdminRouteContext): Response | null {
  if (path !== "/admin/api/prompt-rewrite") return null;
  if (method === "GET") {
    return jsonResp({ latest: latestPromptObservation(opts.config), defaults: defaultPromptRewriteConfig() });
  }
  if (method === "DELETE") {
    clearPromptObservation(opts.config);
    return jsonResp({ ok: true });
  }
  return null;
}
