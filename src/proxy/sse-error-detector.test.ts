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

test("passes through empty stream", async () => {
  const resp = sseResponse([]);

  const converted = await detectSseErrorAndConvert(resp);

  expect(converted.status).toBe(200);
  expect(await readBody(converted)).toBe("");
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

test("skips detection for non-SSE content-type", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"type":"overloaded_error"}`));
      controller.close();
    },
  });
  const resp = new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const converted = await detectSseErrorAndConvert(resp);

  // Should pass through unchanged (JSON, not SSE)
  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("application/json");
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
