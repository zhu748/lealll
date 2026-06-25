/**
 * Tests for SSE error detector — catches errors hidden inside HTTP 200 SSE streams.
 */
import { test, expect } from "bun:test";
import { detectSseErrorAndConvert } from "./sse-error-detector.js";

/** Helper: build an SSE response like a real upstream would send. */
function sseResponse(chunks: string[], status: number = 200, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "content-type": "text/event-stream",
      ...headers,
    },
  });
}

/** Helper: read the full response body as text. */
async function readBody(resp: Response): Promise<string> {
  return await resp.text();
}

// ---------------------------------------------------------------------------
// Detection: should convert SSE error events to synthetic HTTP error responses
// ---------------------------------------------------------------------------

test("detects standard Anthropic error event: event: error + data with error wrapper", async () => {
  const sseBody = [
    `event: error\n`,
    `data: {"type":"error","error":{"type":"overloaded_error","message":"[1305] model busy"}}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("content-type")).toBe("application/json");
  const body = JSON.parse(await readBody(converted));
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("overloaded_error");
  expect(body.error.message).toContain("1305");
});

test("detects direct error type: data with overloaded_error as top-level type", async () => {
  // This is the format GLM's gateway actually sends (matching user's screenshot)
  const sseBody = [
    `data: {"type":"overloaded_error","message":"[1305][该模型当前访问量过大, 请您稍后再试][2026062217352770a2366b086e483f]"}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  const body = JSON.parse(await readBody(converted));
  expect(body.error.type).toBe("overloaded_error");
  expect(body.error.message).toContain("1305");
});

test("detects raw JSON error without SSE framing", async () => {
  // Some gateways send the error body as raw JSON (no event:/data: prefix)
  const rawJson = `{"type":"overloaded_error","message":"server overloaded"}`;
  const resp = sseResponse([rawJson]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  const body = JSON.parse(await readBody(converted));
  expect(body.error.type).toBe("overloaded_error");
});

test("detects rate_limit_error and maps to 429", async () => {
  const sseBody = [
    `event: error\n`,
    `data: {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(429);
  const body = JSON.parse(await readBody(converted));
  expect(body.error.type).toBe("rate_limit_error");
});

test("detects error split across multiple chunks", async () => {
  // Error event split across 3 chunks — detector should buffer and find it
  const sseBody = [
    `event: er`,
    `ror\ndata: {"type":"err`,
    `or","error":{"type":"overloaded_error","message":"busy"}}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
});

// ---------------------------------------------------------------------------
// Pass-through: should NOT convert legitimate SSE streams
// ---------------------------------------------------------------------------

test("passes through legitimate stream with message_start event", async () => {
  const sseBody = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"glm-5.2"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("text/event-stream");
  const body = await readBody(converted);
  expect(body).toContain("message_start");
  expect(body).toContain("Hello");
  expect(body).toContain("message_stop");
});

test("passes through stream when ping comes before content", async () => {
  const sseBody = [
    `event: ping\ndata: {"type":"ping"}\n\n`,
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  const body = await readBody(converted);
  expect(body).toContain("ping");
  expect(body).toContain("Hi");
});

test("converts empty stream to synthetic 529 with x-zcode-empty-stream marker", async () => {
  // EMPTY-STREAM DETECTION (bugfix): an HTTP 200 + text/event-stream response
  // with zero SSE events is the signature of a quota-exhausted upstream
  // gateway. Previously the proxy passed this through as a "valid" 200 with
  // an empty body, causing Claude Code / Codex CLI to report "empty or
  // malformed response". Now we convert it to a synthetic 529 so the retry
  // logic kicks in (3 retries then credential switch).
  const resp = sseResponse([]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
  const body = await readBody(converted);
  expect(body).toContain("overloaded_error");
  expect(body).toContain("empty SSE stream");
});

// ---------------------------------------------------------------------------
// Edge cases: should skip detection for non-SSE or compressed responses
// ---------------------------------------------------------------------------

test("skips detection for non-200 responses", async () => {
  const resp = sseResponse(
    [`data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n`],
    529, // already 529 — no need to detect
  );

  const converted = await detectSseErrorAndConvert(resp);

  // Should return the original 529 unchanged
  expect(converted.status).toBe(529);
});

test("skips detection for compressed SSE (content-encoding: gzip)", async () => {
  const resp = sseResponse(
    [`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n`],
    200,
    { "content-encoding": "gzip" },
  );

  const converted = await detectSseErrorAndConvert(resp);

  // Should pass through unchanged (can't decode gzip as UTF-8)
  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-encoding")).toBe("gzip");
});

test("skips detection when response has no body", async () => {
  const resp = new Response(null, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  expect(converted.body).toBe(null);
});

// ---------------------------------------------------------------------------
// Byte-for-byte integrity: legitimate streams must be unchanged
// ---------------------------------------------------------------------------

test("reconstructed stream is byte-for-byte identical to original", async () => {
  const originalChunks = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3","model":"glm-5.2"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"World"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const expectedFullBody = originalChunks.join("");

  const resp = sseResponse(originalChunks);
  const converted = await detectSseErrorAndConvert(resp);

  const actualBody = await readBody(converted);
  expect(actualBody).toBe(expectedFullBody);
});

// ---------------------------------------------------------------------------
// vceshi0.0.9 BUGFIX: empty-stream detection was too strict
// ---------------------------------------------------------------------------
// Previously required `bufferedChunks.length === 0` (zero bytes read). But
// quota-exhausted gateways typically return a few bytes of whitespace, an SSE
// comment line (`: keepalive\n\n`), or an empty event block (`\n\n`) before
// closing the connection. All of these produce `bufferedChunks.length > 0`
// while `sawAnyCompleteEvent === false`. The old check fell through to
// reconstructStream, passing the bogus 200 to the client → no retry → no
// credential switch → user sees "200 OK but no output".
//
// The fix: trigger whenever `!sawAnyCompleteEvent`, regardless of byte count.

test("converts SSE stream with only whitespace to synthetic 529 (empty-stream fix)", async () => {
  // Just `\n\n` (an empty SSE event block) — old check would NOT trigger
  // because bufferedChunks.length === 1.
  const resp = sseResponse(["\n\n"]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
  const body = await readBody(converted);
  expect(body).toContain("overloaded_error");
  expect(body).toContain("empty SSE stream");
});

test("converts SSE stream with only a comment line to synthetic 529", async () => {
  // SSE comment lines start with `:` — used for keep-alive. A stream that
  // contains only comments and no real events is effectively empty.
  // Old check would NOT trigger because bufferedChunks.length === 1.
  const resp = sseResponse([": keepalive\n\n"]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts SSE stream with only partial event fragment to synthetic 529", async () => {
  // Partial event without `\n\n` terminator — never becomes a complete event.
  // Old check would NOT trigger because bufferedChunks.length === 1.
  const resp = sseResponse(["event: message_start\n"]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("still passes through stream that starts with ping then has real content", async () => {
  // Make sure the loosened check doesn't false-positive on legitimate
  // streams that begin with a ping event before the actual content.
  // `ping` is a non-error event, so hasNonErrorEvent() returns true and
  // sawAnyCompleteEvent becomes true → no false conversion.
  const sseBody = [
    `event: ping\ndata: {"type":"ping"}\n\n`,
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_4"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n`,
  ];
  const resp = sseResponse(sseBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  const body = await readBody(converted);
  expect(body).toContain("Hi");
});

// ---------------------------------------------------------------------------
// vceshi0.0.9 BUGFIX: non-SSE (application/json) 200 empty responses
// ---------------------------------------------------------------------------
// Previously the detector skipped non-SSE responses entirely. Batch requests
// (stream: false) return application/json, and when quota is exhausted the
// gateway often returns HTTP 200 with an empty body, or `{}`, or a JSON
// object missing the `content` / `choices` field. The detector skipped
// these entirely → no retry → no credential switch → the empty 200 was
// passed straight to the client.
//
// User-visible symptom (from log):
//   | #063 | ... | glm-5.2 | batch | 200 | 1019ms | in:- out:- |

/** Build an application/json response. */
function jsonResponse(body: string, status: number = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("converts application/json 200 with empty body to synthetic 529", async () => {
  const resp = jsonResponse("");

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
  expect(converted.headers.get("content-type")).toBe("application/json");
  const body = await readBody(converted);
  expect(body).toContain("overloaded_error");
});

test("converts application/json 200 with whitespace-only body to 529", async () => {
  const resp = jsonResponse("   \n  \n");

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts application/json 200 with `{}` to synthetic 529", async () => {
  const resp = jsonResponse("{}");

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts application/json 200 with malformed JSON to 529", async () => {
  // Truncated mid-stream — gateway closed the connection during quota cutoff
  const resp = jsonResponse('{"content":[{"type":"text","text":"partial');

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts application/json 200 with null body to 529", async () => {
  const resp = jsonResponse("null");

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts application/json 200 with empty array to 529", async () => {
  const resp = jsonResponse("[]");

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("converts application/json 200 with empty Anthropic content + no usage to 529", async () => {
  // `{"content":[]}` with no usage — Anthropic's "model refused" responses
  // still include a usage block. content:[] + no usage = quota-exhausted.
  const resp = jsonResponse('{"id":"msg_1","content":[],"model":"glm-5.2"}');

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(529);
  expect(converted.headers.get("x-zcode-empty-stream")).toBe("1");
});

test("passes through application/json 200 with Anthropic content + usage", async () => {
  // Real Anthropic response — has content array AND usage block
  const realBody = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "glm-5.2",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const resp = jsonResponse(realBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("application/json");
  const body = await readBody(converted);
  expect(body).toBe(realBody); // byte-for-byte unchanged
});

test("passes through application/json 200 with empty content but with usage", async () => {
  // Anthropic "model refused" responses have content:[] but include usage
  // (counting the input tokens that were processed before refusal).
  // This is a legitimate response, NOT a quota-exhausted signature.
  const realBody = JSON.stringify({
    id: "msg_2",
    content: [],
    usage: { input_tokens: 50, output_tokens: 0 },
  });
  const resp = jsonResponse(realBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  const body = await readBody(converted);
  expect(body).toBe(realBody);
});

test("passes through application/json 200 with OpenAI choices", async () => {
  const realBody = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: "Hi" } }],
  });
  const resp = jsonResponse(realBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  const body = await readBody(converted);
  expect(body).toBe(realBody);
});

test("passes through application/json 200 with Responses API output", async () => {
  const realBody = JSON.stringify({
    id: "resp_1",
    object: "response",
    output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }],
  });
  const resp = jsonResponse(realBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  const body = await readBody(converted);
  expect(body).toBe(realBody);
});

test("passes through application/json 200 with embedded error field", async () => {
  // If the upstream already returned an error-shaped JSON, leave it alone —
  // the existing error passthrough in handler.ts will surface it to the
  // client with the proper error structure.
  const errBody = JSON.stringify({
    type: "error",
    error: { type: "authentication_error", message: "invalid api key" },
  });
  const resp = jsonResponse(errBody);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200); // unchanged
  expect(converted.headers.get("x-zcode-empty-stream")).toBe(null);
  const body = await readBody(converted);
  expect(body).toBe(errBody);
});

test("still skips detection for other content-types (text/plain, etc.)", async () => {
  // Only application/json and text/event-stream are inspected. Other
  // content-types are passed through unchanged.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("some text"));
      controller.close();
    },
  });
  const resp = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("text/plain");
  const body = await readBody(converted);
  expect(body).toBe("some text");
});
