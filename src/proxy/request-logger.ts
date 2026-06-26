/**
 * Upstream request logger — saves every request (headers + body) the proxy
 * sends to z.ai / bigmodel upstream as JSON files in a configurable directory.
 *
 * Purpose: debug what the proxy ACTUALLY sends upstream after all body
 * transforms (thinking rewrite, system block rewrite, cache_control
 * sanitization, etc.). The log files are full JSON with method, URL, headers
 * (auth tokens masked), and parsed body — open in any JSON viewer to inspect.
 *
 * FIFO cleanup: when file count exceeds `maxCount`, the oldest files (by mtime)
 * are deleted. This bounds disk usage.
 *
 * Auth token masking: `Authorization` and `x-api-key` headers are masked to
 * the first 8 chars + "..." to avoid leaking full credentials to disk. The
 * mask is enough to identify WHICH credential was used (compare with the
 * dashboard's masked API key display) without exposing the full secret.
 *
 * Failure mode: ALL errors are caught and logged to stderr. The logger must
 * NEVER break the request flow — if disk is full, permissions are wrong, etc.,
 * we just skip the log and let the request proceed.
 */
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RequestLogOpts {
  enabled: boolean;
  maxCount: number;
  dir: string;
}

/**
 * Save the upstream request (headers + body) to a JSON file in the log dir.
 * Enforces FIFO: if file count exceeds maxCount, deletes oldest by mtime.
 *
 * @param req The built upstream Request (used for method, URL, headers)
 * @param body The transformed body string (passed separately because Request.body
 *             is a ReadableStream that would be consumed if read)
 * @param reqId Request ID for correlation with console logs
 * @param opts Logger options
 */
export function logUpstreamRequest(
  req: Request,
  body: string | undefined,
  reqId: string,
  opts: RequestLogOpts,
): void {
  if (!opts.enabled) return;

  // Ensure dir exists
  try {
    if (!existsSync(opts.dir)) {
      mkdirSync(opts.dir, { recursive: true });
    }
  } catch (e) {
    console.error(`[request-logger] mkdir failed for ${opts.dir}:`, e);
    return;
  }

  // Build the log entry
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {};
  try {
    req.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "authorization" || lower === "x-api-key") {
        headers[key] = maskToken(value);
      } else {
        headers[key] = value;
      }
    });
  } catch (e) {
    console.error(`[request-logger] header extraction failed:`, e);
    return;
  }

  // Parse body if JSON, else keep as string
  let parsedBody: unknown = body;
  if (typeof body === "string" && body.length > 0) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      // Not valid JSON — keep as string
    }
  }

  const entry = {
    timestamp,
    reqId,
    method: req.method,
    url: req.url,
    headers,
    body: parsedBody,
  };

  // Write file — filename includes ISO timestamp + reqId + random suffix for
  // uniqueness across retries in the same millisecond
  const safeTs = timestamp.replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `upstream-${safeTs}-${reqId}-${rand}.json`;
  const filepath = join(opts.dir, filename);

  try {
    writeFileSync(filepath, JSON.stringify(entry, null, 2));
  } catch (e) {
    console.error(`[request-logger] write failed for ${filepath}:`, e);
    return;
  }

  // Enforce maxCount (FIFO by mtime)
  try {
    const files = readdirSync(opts.dir)
      .filter(f => f.startsWith("upstream-") && f.endsWith(".json"))
      .map(f => {
        const fp = join(opts.dir, f);
        try {
          return { name: f, path: fp, mtime: statSync(fp).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; path: string; mtime: number } => x !== null)
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    while (files.length > opts.maxCount) {
      const oldest = files.shift();
      if (oldest) {
        try {
          unlinkSync(oldest.path);
        } catch {
          // File might have been deleted by a concurrent request — ignore
        }
      }
    }
  } catch (e) {
    console.error(`[request-logger] cleanup failed:`, e);
  }
}

/**
 * Mask an auth token for logging. Preserves enough to identify which credential
 * was used (first 8 chars) without exposing the full secret.
 *
 * Examples:
 *   "Bearer eyJhbGciOi..." → "Bearer eyJhbGci..."
 *   "abc123secret"          → "abc123se..."
 *   "short"                 → "***"
 */
function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  if (token.startsWith("Bearer ")) {
    const rest = token.slice(7);
    if (rest.length <= 8) return "Bearer ***";
    return `Bearer ${rest.slice(0, 8)}...`;
  }
  return `${token.slice(0, 8)}...`;
}
