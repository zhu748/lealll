import type { Format } from "../translator/types.js";
import { recordStat } from "../admin/api.js";
import { runtimeLog, shouldEmitRuntimeLog } from "../utils/log.js";
import { SSE as SSE_CONST } from "../utils/constants.js";
import { isCompressedContentEncoding, utf8ByteLength } from "./response-body.js";

export interface RequestMeta {
  model: string;
  stream: boolean;
}

export function shouldEmitProxyLog(): boolean {
  return shouldEmitRuntimeLog("log");
}

export function proxyLog(...args: unknown[]): void {
  runtimeLog(...args);
}

let headerPrinted = false;

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  proxyLog(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB | Captcha |   Tok |  tok/s |   Total |",
  );
  proxyLog(
    "|------|------------|-----|-------------|--------|------|---------|---------|-------|--------|---------|",
  );
}

export function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
  retried: boolean = false,
  inputTokens: number = 0,
  credKey?: string,
  captchaMs: number = 0,
  cacheReadTokens: number = 0,
  thinkingTokens: number = 0,
): void {
  printHeader();
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : format === "openai-responses" ? "RSP" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfbMs = Math.max(0, headersAt - started);
  const ttfb = `${ttfbMs}ms`;
  const captcha = captchaMs > 0 ? `${captchaMs}ms` : "-";
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  // v0.2.0.6: input token display reflects the TOTAL input the model saw
  // (new input + cache_read + cache_creation). When cache is in play, also
  // show the cache-hit portion inline so users can see prompt caching is
  // working: "in: 41152 (c:40000) out: 4413".
  const totalInput = inputTokens + cacheReadTokens;
  const inTok = totalInput > 0 ? String(totalInput) : "-";
  const cacheMarker = cacheReadTokens > 0 ? `(c:${cacheReadTokens})` : "";
  const inField = `${inTok.padStart(5)}${cacheMarker}`.trim();
  // v0.2.0.7: when thinking is enabled, GLM streams thinking_delta events
  // before the final text output. Show thinking token count inline so users
  // can distinguish "model is thinking" from "model produced final answer".
  // Format: "out: 529 (th:1234)" means 529 output tokens + 1234 thinking tokens.
  const thinkMarker = thinkingTokens > 0 ? `(th:${thinkingTokens})` : "";
  const outField = `${tok.padStart(5)}${thinkMarker}`.trim();
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  // When captcha took a significant portion of TTFB, show the breakdown
  if (captchaMs > 0 && ttfbMs > 0) {
    const netTtfb = Math.max(0, ttfbMs - captchaMs);
    proxyLog(
      `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${captcha.padStart(7)} | in:${inField} out:${outField} | ${tps.padStart(6)} | ${total.padStart(7)} |  TTFB=${ttfbMs}ms (net ${netTtfb}ms + captcha ${captchaMs}ms)`,
    );
  } else {
    proxyLog(
      `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${captcha.padStart(7)} | in:${inField} out:${outField} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
    );
  }
  // Record stats for the admin dashboard
  recordStat({
    id: reqId,
    time: ts,
    model: meta.model,
    status,
    ttfb: String(ttfbMs),
    tokens: String(tokens),
    inputTokens: String(totalInput),
    cacheReadTokens: cacheReadTokens > 0 ? String(cacheReadTokens) : undefined,
    credentialKey: credKey,
    retried,
    captchaMs: String(captchaMs),
  });
}

/**
 * Build a TransformStream that observes an SSE/byte stream for stats while
 * passing every chunk through to the client unchanged.
 *
 * v0.2.0.8: replaces the `body.tee()` + parallel `observeStream()` reader
 * pattern. The tee() approach forced both branches to share one internal
 * buffer in Bun's whatwg implementation: the slow stats reader (fire-and-
 * forget async) held back the fast client branch, so on long LLM streams
 * (100K+ tokens) the entire response buffered in memory until the stats
 * reader caught up — doubling peak memory.
 *
 * This TransformStream parses each chunk inline during the `transform()`
 * callback, which runs on the same pump as the client response. No second
 * reader, no shared buffer, no back-pressure stall. Bytes flow through and
 * are parsed in-place.
 */
export function createStatsTransform(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  contentEncoding: string | null,
  credKey: string | undefined,
  captchaMs: number,
  retried: boolean = false,
): { transform: TransformStream<Uint8Array, Uint8Array>; done: Promise<void>; finalize: () => void } {
  const compressed = isCompressedContentEncoding(contentEncoding);
  const state = {
    tokens: 0,
    inputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    sseBuffer: "",
    statsParsingDisabled: false,
    firstChunkAt: 0,
  };
  const decoder = compressed ? null : new TextDecoder();

  let finished = false;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const finalize = (): void => {
    if (finished) return;
    finished = true;
    try {
      if (!compressed && !state.statsParsingDisabled) {
        const tail = decoder!.decode();
        if (tail) state.sseBuffer += tail;
      }
      if (!compressed && !state.statsParsingDisabled && utf8ByteLength(state.sseBuffer) > SSE_CONST.MAX_STATS_BUFFERED_EVENT_BYTES) {
        state.sseBuffer = "";
        state.statsParsingDisabled = true;
      }
      if (!compressed && !state.statsParsingDisabled && state.sseBuffer) {
        observeStreamParseSse(state.sseBuffer, state);
      }
      const endAt = Date.now();
      const ttfbMs = (state.firstChunkAt > 0 ? state.firstChunkAt : endAt) - requestSentAt;
      const totalMs = endAt - requestSentAt;
      const avgTps = state.tokens > 0 && totalMs > 0 ? state.tokens / (totalMs / 1000) : 0;
      printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, state.tokens, avgTps, endAt, retried, state.inputTokens, credKey, captchaMs, state.cacheReadTokens, state.thinkingTokens);
    } finally {
      resolveDone();
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (state.firstChunkAt === 0) state.firstChunkAt = Date.now();
      if (!compressed && !state.statsParsingDisabled) {
        state.sseBuffer += decoder!.decode(chunk, { stream: true });
        const idx = state.sseBuffer.lastIndexOf("\n");
        if (idx >= 0) {
          observeStreamParseSse(state.sseBuffer.slice(0, idx), state);
          state.sseBuffer = state.sseBuffer.slice(idx + 1);
        }
        if (utf8ByteLength(state.sseBuffer) > SSE_CONST.MAX_STATS_BUFFERED_EVENT_BYTES) {
          state.sseBuffer = "";
          state.statsParsingDisabled = true;
        }
      }
      // Pass the chunk straight through to the client — no buffering.
      controller.enqueue(chunk);
    },
    flush() {
      finalize();
    },
  });

  return { transform, done, finalize };
}

export function observeStatsStream(
  source: ReadableStream<Uint8Array>,
  stats: ReturnType<typeof createStatsTransform>,
): ReadableStream<Uint8Array> {
  const reader = source.pipeThrough(stats.transform).getReader();
  let closed = false;
  const releaseReader = (): void => {
    try { reader.releaseLock(); } catch {}
  };
  const closeStream = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch {}
  };
  const errorStream = (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown): void => {
    if (closed) return;
    closed = true;
    try { controller.error(err); } catch {}
  };
  const enqueueStream = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(value);
      return true;
    } catch (err) {
      errorStream(controller, err);
      return false;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          stats.finalize();
          releaseReader();
          closeStream(controller);
          return;
        }
        if (value && !enqueueStream(controller, value)) {
          stats.finalize();
          releaseReader();
        }
      } catch (err) {
        stats.finalize();
        releaseReader();
        errorStream(controller, err);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      stats.finalize();
      try {
        await reader.cancel(reason);
      } catch {
        // Best-effort cancellation; downstream is already gone.
      } finally {
        releaseReader();
      }
    },
  });
}

function observeStreamParseSse(text: string, state: {
  tokens: number; inputTokens: number; thinkingTokens: number; cacheReadTokens: number;
}): void {
  let lineStart = 0;
  for (;;) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    if (text.startsWith("data:", lineStart)) {
      observeStreamParseDataLine(text.slice(lineStart + 5, end).trimStart(), state);
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
}

function observeStreamParseDataLine(dataStr: string, state: {
  tokens: number; inputTokens: number; thinkingTokens: number; cacheReadTokens: number;
}): void {
  if (!dataStr || dataStr === "[DONE]") return;
  // v0.2.2+ PERF: cheap substring check before JSON.parse. The markers
  // below cover every branch that actually updates state — anything
  // without one of these markers is guaranteed to be a no-op (the
  // try/catch below would parse and discard it).
  let hasMarker = false;
  for (const marker of SSE_CONST.STATS_INTERESTING_MARKERS) {
    if (dataStr.includes(marker)) { hasMarker = true; break; }
  }
  if (!hasMarker) return;
  try {
    const j = JSON.parse(dataStr);
    if (j.type === "message_start" && j.message?.usage) {
      const u = j.message.usage;
      if (typeof u.input_tokens === "number" && u.input_tokens > 0) state.inputTokens = u.input_tokens;
      if (typeof u.cache_read_input_tokens === "number" && u.cache_read_input_tokens > 0) state.cacheReadTokens = u.cache_read_input_tokens;
    }
    if (j.usage?.completion_tokens) { state.tokens = j.usage.completion_tokens; }
    if (j.usage?.output_tokens) { state.tokens = j.usage.output_tokens; }
    if (j.usage?.prompt_tokens) { state.inputTokens = j.usage.prompt_tokens; }
    if (j.usage?.input_tokens) { state.inputTokens = j.usage.input_tokens; }
    if (j.usage?.cache_read_input_tokens) { state.cacheReadTokens = j.usage.cache_read_input_tokens; }
    const oai = j.choices?.[0]?.delta?.content;
    if (typeof oai === "string" && oai.length > 0) { state.tokens++; return; }
    if (j.type === "content_block_delta" && j.delta?.type === "thinking_delta") {
      const t = j.delta?.thinking;
      if (typeof t === "string" && t.length > 0) state.thinkingTokens++;
      return;
    }
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
      const t = j.delta?.text;
      if (typeof t === "string" && t.length > 0) state.tokens++;
      return;
    }
    if (j.type === "response.output_text.delta") {
      const t = j.delta;
      if (typeof t === "string" && t.length > 0) state.tokens++;
      return;
    }
    if (j.type === "response.completed" && j.response?.usage) {
      const u = j.response.usage;
      if (u.output_tokens) state.tokens = u.output_tokens;
      if (u.input_tokens) state.inputTokens = u.input_tokens;
      if (u.cache_read_input_tokens) state.cacheReadTokens = u.cache_read_input_tokens;
      // v0.2.0.10: Responses API carries thinking token count in
      // usage.output_tokens_details.reasoning_tokens. Prefer this
      // authoritative value over chunk counting when present.
      const rt = u.output_tokens_details?.reasoning_tokens;
      if (typeof rt === "number" && rt > 0) state.thinkingTokens = rt;
      return;
    }
    if (j.type === "message_delta" && j.usage) {
      if (j.usage.output_tokens) state.tokens = j.usage.output_tokens;
      if (j.usage.input_tokens) state.inputTokens = j.usage.input_tokens;
      if (j.usage.cache_read_input_tokens) state.cacheReadTokens = j.usage.cache_read_input_tokens;
      // v0.2.0.10: GLM extension — message_delta.usage may carry an
      // authoritative reasoning_tokens count. Prefer it over chunk counting.
      if (typeof j.usage.reasoning_tokens === "number" && j.usage.reasoning_tokens > 0) state.thinkingTokens = j.usage.reasoning_tokens;
      return;
    }
    // v0.2.0.10: Chat Completions streaming — the final chunk carries usage
    // with cache_read_input_tokens / reasoning_tokens as non-standard
    // extension fields (added by sse-translator.ts). OpenAI chunks don't
    // have a `type` field, so we match by the presence of `choices` +
    // `usage`. This must run AFTER the message_delta / response.completed
    // branches above so those take precedence on type collisions.
    if (j.choices && j.usage) {
      if (j.usage.cache_read_input_tokens) state.cacheReadTokens = j.usage.cache_read_input_tokens;
      if (typeof j.usage.reasoning_tokens === "number" && j.usage.reasoning_tokens > 0) state.thinkingTokens = j.usage.reasoning_tokens;
    }
  } catch {}
}
