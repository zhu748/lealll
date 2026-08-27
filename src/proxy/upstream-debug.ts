import {
  isCompressedContentEncoding,
  readResponseTextPreview,
  truncateUtf8ForLog,
} from "./response-body.js";
import { proxyLog } from "./stats.js";

/**
 * Debug log the upstream response without throwing.
 *
 * The caller can pass a tee'd preview branch when the original response body
 * must remain available for passthrough. This avoids relying on Response.clone()
 * cancellation behavior, which is not fully isolated in Bun for streaming
 * bodies.
 */
export async function logUpstreamResponseDebug(
  reqId: string,
  resp: Response,
  alreadyPreviewResponse = false,
): Promise<void> {
  try {
    const status = resp.status;
    const ct = resp.headers.get("content-type") ?? "";
    const ce = resp.headers.get("content-encoding") ?? "";
    const retryAfter = resp.headers.get("retry-after") ?? "";
    const emptyStream = resp.headers.get("x-zcode-empty-stream") ?? "";
    const ratelimitRemaining = resp.headers.get("anthropic-ratelimit-requests-remaining")
      ?? resp.headers.get("x-ratelimit-remaining") ?? "";

    const headerParts: string[] = [`status=${status}`, `ct=${ct || "(none)"}`];
    if (isCompressedContentEncoding(ce)) headerParts.push(`encoding=${ce}`);
    if (retryAfter) headerParts.push(`retry-after=${retryAfter}`);
    if (emptyStream) headerParts.push(`empty-stream=${emptyStream}`);
    if (ratelimitRemaining) headerParts.push(`ratelimit-remaining=${ratelimitRemaining}`);
    proxyLog(`${reqId} [debug] upstream response: ${headerParts.join(" | ")}`);

    const isSSE = ct.includes("text/event-stream");
    const previewTimeoutMs = isSSE ? 10_000 : 3_000;
    const previewCap = isSSE ? 8192 : 2048;
    const previewResult = await readResponseTextPreview(resp, {
      maxBytes: previewCap,
      timeoutMs: previewTimeoutMs,
      clone: !alreadyPreviewResponse,
    }).catch(() => null);
    const preview = previewResult
      ? `${previewResult.text}${previewResult.truncated ? `...(truncated at ${previewCap} bytes)` : previewResult.timedOut ? `...(read timeout after ${previewTimeoutMs / 1000}s)` : ""}`
      : "(body read failed)";

    const trimCapBytes = isSSE ? 8000 : 1000;
    const trimmed = truncateUtf8ForLog(preview, trimCapBytes);
    const suffix = trimmed.truncated ? `...(truncated, total ${trimmed.bytes} bytes)` : "";
    proxyLog(`${reqId} [debug] body preview (${trimmed.bytes} bytes): ${trimmed.text}${suffix || (trimmed.text ? "" : "(empty body)")}`);
  } catch (err) {
    proxyLog(`${reqId} [debug] failed to log response: ${(err as Error).message}`);
  }
}
