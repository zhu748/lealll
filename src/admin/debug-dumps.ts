import { errorResponse } from "../proxy/translated-response.js";
import { appendLog } from "./logs.js";
import { parseQueryLimit } from "./http-utils.js";
import { jsonResp } from "./security.js";
import type { AdminRouteContext } from "./types.js";

// ---------------------------------------------------------------------------
// Debug dump ring buffer (replaces the old writeFileSync-to-disk approach).
// Upstream 4xx bodies used to be written to <cwd>/zcode-proxy-debug-*.json,
// which leaked user conversation content to disk forever. Now we keep the
// last 20 dumps in memory and expose them via /admin/api/debug-dumps.
// ---------------------------------------------------------------------------
const DEBUG_DUMP_LIMIT = 20;

const DEBUG_DUMP_BODY_MAX_CHARS = 64 * 1024;

const DEBUG_DUMP_SUMMARY_MAX_CHARS = 8 * 1024;

const DEBUG_DUMP_ERROR_MAX_CHARS = 2 * 1024;

const DEBUG_DUMP_BETA_MAX_CHARS = 1024;

const debugDumps: Array<{
  id: string;
  time: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}> = [];

function truncateDebugDumpField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

/**
 * Record a 4xx upstream response's transformed body for diagnostics.
 * Called from handler.ts when upstream returns 4xx.
 */
export function recordDebugDump(entry: {
  id: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}): void {
  debugDumps.push({
    id: entry.id,
    status: entry.status,
    upstreamError: truncateDebugDumpField(entry.upstreamError, DEBUG_DUMP_ERROR_MAX_CHARS),
    anthropicBeta: truncateDebugDumpField(entry.anthropicBeta, DEBUG_DUMP_BETA_MAX_CHARS),
    bodySummary: truncateDebugDumpField(entry.bodySummary, DEBUG_DUMP_SUMMARY_MAX_CHARS),
    body: truncateDebugDumpField(entry.body, DEBUG_DUMP_BODY_MAX_CHARS),
    time: new Date().toISOString().slice(11, 19),
  });
  if (debugDumps.length > DEBUG_DUMP_LIMIT) {
    debugDumps.splice(0, debugDumps.length - DEBUG_DUMP_LIMIT);
  }
}

/** Clear all debug dumps. */
export function clearDebugDumps(): void {
  debugDumps.length = 0;
}

/** Feature handler; authorization is enforced by admin/router.ts. */
export function handleDebugDumpsRoutes(context: AdminRouteContext): Response | null {
  const { url, path, method } = context;

  // Get debug dumps (memory ring buffer of upstream 4xx transformed bodies).
  // Replaces the old writeFileSync-to-disk approach that leaked user
  // conversation content to <cwd>/zcode-proxy-debug-*.json forever.
  if (path === "/admin/api/debug-dumps" && method === "GET") {
    const limit = parseQueryLimit(url.searchParams.get("limit"), 20, 100);
    // Strip the full body by default — only return it when ?full=1.
    // Bodies can be 90KB+ and may contain user conversation content, so we
    // hide them behind an explicit opt-in to avoid surprising the user.
    const includeBody = url.searchParams.get("full") === "1";
    const dumpId = url.searchParams.get("id");
    if (dumpId) {
      const dump = debugDumps.find(d => d.id === dumpId);
      if (!dump) return errorResponse(404, "not_found", "Debug dump not found");
      return jsonResp(includeBody ? dump : { ...dump, body: undefined });
    }
    return jsonResp({
      dumps: (limit <= 0 ? [] : debugDumps.slice(-limit).reverse()).map(d =>
        includeBody ? d : { ...d, body: undefined }
      ),
      total: debugDumps.length,
    });
  }

  // Clear debug dumps
  if (path === "/admin/api/debug-dumps" && method === "DELETE") {
    clearDebugDumps();
    appendLog("info", "Debug dumps cleared by admin");
    return jsonResp({ ok: true });
  }
  return null;
}
