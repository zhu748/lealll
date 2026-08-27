/**
 * v0.3.8.1 regression tests: compressed byte-passthrough upstream responses.
 *
 * Root cause this pins down: zcode.z.ai (behind Alibaba ESA) dynamically
 * gzips SSE responses when the proxy advertises accept-encoding: gzip. The
 * passthrough path fetches with decompress:false, so the stats observer /
 * heartbeat received raw gzip bytes and silently disabled themselves — every
 * dashboard row showed `in:- out:-` with no tok/s. The fix (a) advertises
 * identity upstream and (b) decompresses any compressed passthrough body
 * in-stream so downstream consumers see plaintext again.
 */
import { expect, test } from "bun:test";
import { gzipSync, deflateSync } from "node:zlib";
import { decompressPassthroughResponse } from "./response-body.js";
import { _testing } from "./handler.js";

const { createStatsTransform } = _testing;

const SSE_BODY = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_gz","model":"glm-test","usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
].join("");

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function compressedResponse(
  payload: Uint8Array,
  encoding: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(bytesStream(payload), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "content-encoding": encoding,
      ...extraHeaders,
    },
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(out);
}

test("gzip passthrough SSE is decompressed in-stream and restores token stats (v0.3.8.1 regression)", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const gz = gzipSync(Buffer.from(SSE_BODY, "utf-8")) as unknown as Uint8Array;
    const resp = compressedResponse(gz, "gzip", { "content-length": String(gz.byteLength) });

    const inflated = decompressPassthroughResponse(resp);
    expect(inflated.decompressed).toBe(true);
    expect(inflated.unsupportedEncoding).toBeNull();
    // content-encoding + content-length must both be stripped — neither
    // describes the decompressed body any more.
    expect(inflated.response.headers.get("content-encoding")).toBeNull();
    expect(inflated.response.headers.get("content-length")).toBeNull();
    // Other headers survive (the passthrough forwardlist keeps content-type).
    expect(inflated.response.headers.get("content-type")).toBe("text/event-stream");

    // The decompressed stream is exactly what the stats observer must see:
    // plaintext SSE with usage events → the row regains in:9 out:4.
    const stats = createStatsTransform(
      "GZ1",
      "anthropic",
      { model: "glm-test", stream: true },
      200,
      Date.now(),
      null, // handler passes null after decompression — parsing enabled
      "cred",
      0,
    );
    const output = await readText(inflated.response.body!.pipeThrough(stats.transform));
    await stats.done;

    expect(output).toBe(SSE_BODY);
    expect(logs.some(line => line.includes("| GZ1") && line.includes("in:9 out:4"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("deflate passthrough body is decompressed", async () => {
  const raw = JSON.stringify({ ok: true, usage: { input_tokens: 3, output_tokens: 5 } });
  const deflated = deflateSync(Buffer.from(raw, "utf-8")) as unknown as Uint8Array;
  const resp = compressedResponse(deflated, "deflate");

  const inflated = decompressPassthroughResponse(resp);
  expect(inflated.decompressed).toBe(true);
  const text = await inflated.response.text();
  expect(text).toBe(raw);
});

test("identity / absent content-encoding responses pass through untouched", () => {
  const plain = compressedResponse(new TextEncoder().encode(SSE_BODY), "identity");
  const a = decompressPassthroughResponse(plain);
  expect(a.decompressed).toBe(false);
  expect(a.unsupportedEncoding).toBeNull();
  expect(a.response).toBe(plain); // same object — no rewrapping

  const none = new Response(bytesStream(new TextEncoder().encode(SSE_BODY)), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const b = decompressPassthroughResponse(none);
  expect(b.decompressed).toBe(false);
  expect(b.unsupportedEncoding).toBeNull();
  expect(b.response).toBe(none);
});

test("br passthrough body is flagged unsupported and left compressed (Bun DecompressionStream has no br)", () => {
  // Arbitrary bytes standing in for brotli — the helper must not attempt to
  // decode them, just report the encoding so the caller can warn.
  const br = new Uint8Array([0x8b, 0x00, 0x01, 0x02, 0x03]);
  const resp = compressedResponse(br, "br");

  const inflated = decompressPassthroughResponse(resp);
  expect(inflated.decompressed).toBe(false);
  expect(inflated.unsupportedEncoding).toBe("br");
  expect(inflated.response).toBe(resp);
});

test("null-body response passes through unchanged", () => {
  const empty = new Response(null, { status: 204, headers: { "content-encoding": "gzip" } });
  const inflated = decompressPassthroughResponse(empty);
  expect(inflated.decompressed).toBe(false);
  expect(inflated.unsupportedEncoding).toBeNull();
  expect(inflated.response).toBe(empty);
});

test("content-encoding is matched case/whitespace-insensitively (\" GZIP \" decompresses)", async () => {
  const gz = gzipSync(Buffer.from("plain", "utf-8")) as unknown as Uint8Array;
  const resp = compressedResponse(gz, " GZIP ");
  const inflated = decompressPassthroughResponse(resp);
  expect(inflated.decompressed).toBe(true);
  expect(await inflated.response.text()).toBe("plain");
});
