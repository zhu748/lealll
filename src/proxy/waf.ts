import { WAF as WAF_CONST } from "../utils/constants.js";

export type WafBlockResult =
  | { wafBlocked: true }
  | { wafBlocked: false; response: Response };

/**
 * Detect Aliyun WAF block responses.
 *
 * z.ai / zcode.z.ai use Aliyun WAF. When an IP is blacklisted, the WAF
 * returns a non-standard HTML response, often with status 405 / 403 / 200.
 * We peek at a bounded body prefix to confirm the WAF signature, then either
 * report a block or reconstruct a fresh Response from the consumed prefix so
 * downstream code can still read a body.
 */
export async function checkWafBlock(resp: Response): Promise<WafBlockResult> {
  // Fast path: status codes that the WAF typically uses.
  // 405 = Method Not Allowed (the classic WAF block)
  // 403 = Forbidden (sometimes used by WAF or upstream auth failures)
  // 200 = sometimes the WAF returns 200 + HTML instead of an error status
  const isSuspectStatus = resp.status === 405 || resp.status === 403 || resp.status === 200;
  if (!isSuspectStatus) return { wafBlocked: false, response: resp };

  const ct = resp.headers.get("content-type") ?? "";
  // WAF responses are HTML; legitimate API responses are JSON or SSE.
  // If content-type is JSON or SSE, this is NOT a WAF block — and we don't
  // need to consume the body to confirm, so we can return the original
  // response untouched.
  if (ct.includes("application/json") || ct.includes("text/event-stream")) {
    return { wafBlocked: false, response: resp };
  }
  // Strong signal: Tengine server header (Alibaba's nginx fork).
  // But not all WAF responses have it, so we don't require it.
  const server = resp.headers.get("server") ?? "";

  try {
    const MAX_PEEK = WAF_CONST.MAX_PEEK_BYTES;
    let text = "";
    let peekedBytes = 0;
    let bodyDone = false;
    if (resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (peekedBytes < MAX_PEEK) {
          const { done, value } = await reader.read();
          if (done) { bodyDone = true; break; }
          if (!value) continue;
          const remainingBytes = MAX_PEEK - peekedBytes;
          const chunk = value.byteLength > remainingBytes
            ? value.subarray(0, remainingBytes)
            : value;
          peekedBytes += chunk.byteLength;
          text += decoder.decode(chunk, { stream: true });
          // Early-exit: signature found, no need to keep reading.
          if (text.includes(WAF_CONST.SIGNATURE)) {
            bodyDone = false;
            break;
          }
          if (chunk.byteLength < value.byteLength) break;
        }
        if (bodyDone) {
          text += decoder.decode();
        } else {
          // Drop a possible partial character at the byte cap instead of
          // expanding the preview beyond MAX_PEEK_BYTES.
          decoder.decode();
        }
      } finally {
        try { await reader.cancel(); } catch { /* best-effort */ }
      }
    } else {
      return { wafBlocked: false, response: resp };
    }

    if (text.includes("errors.aliyun.com") || (text.includes("aliyun") && text.includes("WAF"))) {
      return { wafBlocked: true };
    }
    if (resp.status === 405 && ct.includes("text/html") && server.toLowerCase().includes("tengine")) {
      return { wafBlocked: true };
    }
    if (ct.includes("text/html") &&
        text.includes("data-spm") &&
        (text.includes("block_message") || text.includes("block_traceid_tips"))) {
      return { wafBlocked: true };
    }
    if (resp.status === 405 && ct.includes("text/html") &&
        /nginx\/1\.(3[1-9]|[4-9]\d|1\d{2}|[2-9]\d{2})/i.test(server)) {
      return { wafBlocked: true };
    }
    if (resp.status === 405 && ct.includes("text/html") &&
        text.length < 2048 &&
        text.includes("<title>405 Not Allowed</title>") &&
        /<hr[^>]*>\s*<center>\s*nginx/i.test(text)) {
      return { wafBlocked: true };
    }
    if (resp.status === 405 && ct.includes("text/html") && text.length < 2048 &&
        (text.includes("<title>405") || text.includes("<h1>405"))) {
      return { wafBlocked: true };
    }

    return {
      wafBlocked: false,
      response: new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      }),
    };
  } catch {
    // Body read failed — return original resp (body may still be readable
    // if the read threw before consuming; if not, downstream will error
    // anyway and there's nothing we can do here).
    return { wafBlocked: false, response: resp };
  }
}
