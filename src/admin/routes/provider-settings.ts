import type { ModelMapping, ResponsesThinkingConfig, RoutingRule } from "../../config/types.js";
import { MODELS as GLM_CATALOG } from "../../provider/models.js";
import { errorResponse } from "../../proxy/translated-response.js";
import { persistConfig } from "../config.js";
import { appendLog } from "../logs.js";
import { readJsonBody } from "../request-body.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleProviderSettingsRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, path, method } = context;

  // Update endpoints (zai/bigmodel anthropicBase + openaiBase).
  //
  // vceshi0.0.7+: validate URLs before applying. The config PUT path goes
  // through validateConfigForSave() which rejects malformed URLs, but this
  // endpoint bypassed that check — meaning a typo like "api.z.ai" (missing
  // https://) would be silently accepted, then 404 every subsequent request
  // until the user noticed. Now we mirror validateConfigForSave's check.
  if (path === "/admin/api/endpoints" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ zai?: Record<string, unknown>; bigmodel?: Record<string, unknown> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Validate first; only apply if all fields pass.
      const allowedFields = ["anthropicBase", "openaiBase"] as const;
      for (const provKey of ["zai", "bigmodel"] as const) {
        const prov = body[provKey];
        if (!prov || typeof prov !== "object") continue;
        for (const field of allowedFields) {
          const v = prov[field];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length === 0) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be a non-empty string`);
          }
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
        // Reject unknown fields to prevent accidental injection of unrelated keys.
        for (const k of Object.keys(prov)) {
          if (!allowedFields.includes(k as any)) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${k} is not allowed on this endpoint (only anthropicBase and openaiBase)`);
          }
        }
      }
      // Apply validated changes
      if (body.zai) Object.assign(opts.config.providers.zai, body.zai);
      if (body.bigmodel) Object.assign(opts.config.providers.bigmodel, body.bigmodel);
      // Persist to disk so changes survive restart (vceshi0.0.5+ fix — previously
      // the in-memory update was hot but lost on restart, silently reverting).
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", "Proxy endpoints updated via admin dashboard");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get routing rules
  if (path === "/admin/api/routing-rules" && method === "GET") {
    return jsonResp({ rules: opts.config.routingRules ?? [] });
  }

  // Update routing rules (full replace)
  if (path === "/admin/api/routing-rules" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ rules?: Array<{ pattern?: string; provider?: string; endpoint?: string; note?: string }> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.rules)) {
        return errorResponse(400, "invalid_request", "rules must be an array");
      }
      // Validate & normalize
      const cleaned: RoutingRule[] = [];
      for (const r of body.rules) {
        if (typeof r.pattern !== "string" || r.pattern.trim() === "") {
          return errorResponse(400, "invalid_rule", "Each rule needs a non-empty 'pattern'");
        }
        if (r.provider !== "zai" && r.provider !== "bigmodel") {
          return errorResponse(400, "invalid_rule", `Rule '${r.pattern}' has invalid provider (must be 'zai' or 'bigmodel')`);
        }
        cleaned.push({
          pattern: r.pattern.trim(),
          provider: r.provider,
          endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
          note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
        });
      }
      opts.config.routingRules = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Routing rules updated (${cleaned.length} rule(s))`);
      return jsonResp({ ok: true, rules: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get model mappings
  if (path === "/admin/api/model-mappings" && method === "GET") {
    return jsonResp({ mappings: opts.config.modelMappings ?? [] });
  }

  // Update model mappings (full replace)
  if (path === "/admin/api/model-mappings" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ mappings?: Array<{ from?: string; to?: string; note?: string }> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.mappings)) {
        return errorResponse(400, "invalid_request", "mappings must be an array");
      }
      const cleaned: ModelMapping[] = [];
      const seenFrom = new Set<string>();
      for (const m of body.mappings) {
        if (typeof m.from !== "string" || m.from.trim() === "") {
          return errorResponse(400, "invalid_mapping", "Each mapping needs a non-empty 'from'");
        }
        if (typeof m.to !== "string" || m.to.trim() === "") {
          return errorResponse(400, "invalid_mapping", `Mapping '${m.from}' has empty 'to'`);
        }
        const fromLower = m.from.trim().toLowerCase();
        if (seenFrom.has(fromLower)) {
          return errorResponse(400, "invalid_mapping", `Duplicate 'from' value: '${m.from}' (case-insensitive)`);
        }
        seenFrom.add(fromLower);
        cleaned.push({
          from: fromLower,
          to: m.to.trim(),
          note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
        });
      }
      opts.config.modelMappings = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Model mappings updated (${cleaned.length} mapping(s))`);
      return jsonResp({ ok: true, mappings: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get GLM model catalog (full pinned list from provider/models.ts).
  // Used by the dashboard for "pull current model list for quick selection"
  // dropdowns in model mappings and responses-thinking config.
  if (path === "/admin/api/glm-models" && method === "GET") {
    return jsonResp({
      models: GLM_CATALOG.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        reasoning: !!m.reasoning,
      })),
    });
  }

  // Get responses-thinking config
  if (path === "/admin/api/responses-thinking" && method === "GET") {
    return jsonResp({ models: opts.config.responsesThinking?.models ?? [] });
  }

  // Update responses-thinking config (full replace)
  if (path === "/admin/api/responses-thinking" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ models?: unknown }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.models)) {
        return errorResponse(400, "invalid_request", "models must be an array of strings");
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of body.models) {
        if (typeof item !== "string") {
          return errorResponse(400, "invalid_model", `Each model must be a string (got ${typeof item})`);
        }
        const id = item.trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(id);
      }
      const cfg: ResponsesThinkingConfig = { models: cleaned };
      opts.config.responsesThinking = cfg;
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Responses thinking override updated (${cleaned.length} model(s))`);
      return jsonResp({ ok: true, models: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }
  return null;
}
