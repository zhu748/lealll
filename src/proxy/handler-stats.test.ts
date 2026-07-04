import { expect, test } from "bun:test";
import { _testing } from "./handler.js";
import { SSE as SSE_CONST } from "../utils/constants.js";

const { createStatsTransform, observeStatsStream, readResponseTextLimited, readResponseTextPreview, printRow, wrapResponseBodyWithUpstreamTimeout } = _testing;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

test("stats transform disables parsing for an oversized unfinished SSE line but keeps passthrough", async () => {
  const input = "data: " + "x".repeat(SSE_CONST.MAX_STATS_BUFFERED_EVENT_BYTES + 1);
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const stats = createStatsTransform(
    "TST",
    "anthropic",
    { model: "glm-test", stream: true },
    200,
    Date.now(),
    null,
    "cred",
    0,
  );

  const output = await collect(source.pipeThrough(stats.transform));
  await stats.done;

  expect(new TextDecoder().decode(output)).toBe(input);
});

test("stats transform counts oversized unfinished SSE lines by UTF-8 bytes", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    const input = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${"汉".repeat(Math.floor(SSE_CONST.MAX_STATS_BUFFERED_EVENT_BYTES / 3) + 1)}"}}`;
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(input));
        controller.close();
      },
    });

    const stats = createStatsTransform(
      "UTF",
      "anthropic",
      { model: "glm-test", stream: true },
      200,
      Date.now(),
      null,
      "cred",
      0,
    );

    const output = await collect(source.pipeThrough(stats.transform));
    await stats.done;

    expect(new TextDecoder().decode(output)).toBe(input);
    expect(logs.some(line => line.includes("| UTF") && line.includes("out:-"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("stats transform still parses identity-encoded SSE streams", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_id","model":"glm-test","usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const stats = createStatsTransform(
      "IDN",
      "anthropic",
      { model: "glm-test", stream: true },
      200,
      Date.now(),
      "identity",
      "cred",
      0,
    );

    const output = await collect(source.pipeThrough(stats.transform));
    await stats.done;

    expect(new TextDecoder().decode(output)).toBe(input);
    expect(logs.some(line => line.includes("| IDN") && line.includes("in:9 out:4"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("printRow clamps captcha-adjusted net TTFB at zero", () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    const started = Date.now();
    printRow(
      "CAP",
      "openai",
      { model: "glm-5.2", stream: false },
      503,
      started,
      started + 5,
      0,
      0,
      0,
      true,
      0,
      "cred",
      7,
    );

    const row = logs.find(line => line.includes("| CAP")) ?? "";
    expect(row).toContain("TTFB=5ms (net 0ms + captcha 7ms)");
    expect(row).not.toContain("net -");
  } finally {
    console.log = originalLog;
  }
});

test("stats transform parses many data lines from one merged chunk", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    const deltas = Array.from({ length: 1000 }, () =>
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    ).join("");
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_many","model":"glm-test","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      deltas,
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const stats = createStatsTransform(
      "MNY",
      "anthropic",
      { model: "glm-test", stream: true },
      200,
      Date.now(),
      null,
      "cred",
      0,
    );

    const output = await collect(source.pipeThrough(stats.transform));
    await stats.done;

    expect(new TextDecoder().decode(output)).toBe(input);
    expect(logs.some(line => line.includes("| MNY") && line.includes("in:12 out:1000"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("stats observed stream finalizes when downstream cancels mid-stream", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    let canceled = false;
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cancel","model":"glm-test","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
      },
      cancel() {
        canceled = true;
      },
    });
    const stats = createStatsTransform(
      "CXL",
      "anthropic",
      { model: "glm-test", stream: true },
      200,
      Date.now(),
      null,
      "cred",
      0,
    );

    const reader = observeStatsStream(source, stats).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(input);
    await reader.cancel("client disconnected");
    await stats.done;

    expect(canceled).toBe(true);
    expect(logs.some(line => line.includes("| CXL") && line.includes("in:7 out:1"))).toBe(true);
  } finally {
    console.log = originalLog;
  }
});

test("response preview clears the per-read timeout when a chunk arrives first", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleared = new Set<ReturnType<typeof setTimeout>>();
  (globalThis as any).setTimeout = (handler: any, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler as any, timeout as any, ...args as any);
    if (timeout === 1000) timers.add(timer);
    return timer;
  };
  (globalThis as any).clearTimeout = (timer?: ReturnType<typeof setTimeout>) => {
    if (timer && timers.has(timer)) cleared.add(timer);
    return originalClearTimeout(timer as any);
  };

  try {
    const encoder = new TextEncoder();
    const resp = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello"));
        controller.close();
      },
    }));

    const preview = await readResponseTextPreview(resp, {
      maxBytes: 100,
      timeoutMs: 1000,
      clone: false,
    });

    expect(preview.text).toBe("hello");
    expect(preview.complete).toBe(true);
    expect(timers.size).toBeGreaterThan(0);
    expect(cleared.size).toBe(timers.size);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("response preview timeout timer stays referenced while it is the awaited fallback", async () => {
  const originalSetTimeout = globalThis.setTimeout as any;
  const unrefDelays: number[] = [];
  (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler, timeout, ...args);
    const originalUnref = timer.unref?.bind(timer);
    timer.unref = () => {
      unrefDelays.push(Number(timeout));
      return originalUnref ? originalUnref() : timer;
    };
    return timer;
  };

  try {
    const resp = new Response("hello");
    const preview = await readResponseTextPreview(resp, {
      maxBytes: 100,
      timeoutMs: 1000,
      clone: false,
    });

    expect(preview.text).toBe("hello");
    expect(unrefDelays).not.toContain(1000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("response preview normalizes pathological timeout values before scheduling timers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  (globalThis as any).setTimeout = (handler: any, timeout?: number, ...args: unknown[]) => {
    delays.push(Number(timeout));
    return originalSetTimeout(handler as any, timeout as any, ...args as any);
  };

  try {
    const resp = new Response("hello");
    const preview = await readResponseTextPreview(resp, {
      maxBytes: 100,
      timeoutMs: Number.POSITIVE_INFINITY,
      clone: false,
    });

    expect(preview.text).toBe("hello");
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every(delay => Number.isFinite(delay) && delay >= 1)).toBe(true);
    expect(delays).not.toContain(Number.POSITIVE_INFINITY);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("response preview releases the reader when it truncates and cancels", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello world"));
    },
    cancel() {
      canceled = true;
    },
  });
  const resp = new Response(stream);

  const preview = await readResponseTextPreview(resp, {
    maxBytes: 5,
    timeoutMs: 1000,
    clone: false,
  });

  expect(preview.text).toBe("hello");
  expect(preview.truncated).toBe(true);
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("response preview does not emit replacement characters when truncating UTF-8", async () => {
  const resp = new Response("汉字");

  const preview = await readResponseTextPreview(resp, {
    maxBytes: 4,
    timeoutMs: 1000,
    clone: false,
  });

  expect(preview.truncated).toBe(true);
  expect(preview.text).toBe("汉");
  expect(preview.text).not.toContain("\uFFFD");
});

test("response preview does not wait for tee passthrough branch when cancelling preview", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello world"));
    },
  });
  const [previewBody, passthroughBody] = source.tee();
  const previewResp = new Response(previewBody);
  const passthroughReader = passthroughBody.getReader();

  try {
    const result = await Promise.race([
      readResponseTextPreview(previewResp, {
        maxBytes: 5,
        timeoutMs: 1000,
        clone: false,
      }),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(result).not.toBe("timeout");
    if (result !== "timeout") {
      expect(result.text).toBe("hello");
      expect(result.truncated).toBe(true);
    }
    expect(previewBody.locked).toBe(false);

    const passthrough = await passthroughReader.read();
    expect(new TextDecoder().decode(passthrough.value)).toBe("hello world");
  } finally {
    try { await passthroughReader.cancel(); } catch {}
  }
});

test("limited response reader releases the lock when the body grows past the cap", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
    },
    cancel() {
      canceled = true;
    },
  });
  const resp = new Response(stream);

  await expect(readResponseTextLimited(resp, 3, "translated response"))
    .rejects.toThrow(/translated response is too large/);
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("upstream timeout wrapper clears its timer after the body is consumed", async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let cleared = false;
  const timer = setTimeout(() => {}, 10_000);
  (globalThis as any).clearTimeout = (candidate?: ReturnType<typeof setTimeout>) => {
    if (candidate === timer) cleared = true;
    return originalClearTimeout(candidate as any);
  };

  try {
    const ctrl = new AbortController();
    const resp = new Response("done");
    const wrapped = wrapResponseBodyWithUpstreamTimeout(resp, ctrl, timer, 10_000);

    expect(await wrapped.text()).toBe("done");
    expect(cleared).toBe(true);
    expect(ctrl.signal.aborted).toBe(false);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    clearTimeout(timer);
  }
});

test("upstream timeout wrapper errors and cancels a stalled body", async () => {
  let canceled = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10);
  const resp = new Response(new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      canceled = true;
    },
  }));
  const wrapped = wrapResponseBodyWithUpstreamTimeout(resp, ctrl, timer, 10);
  const reader = wrapped.body!.getReader();

  await expect(reader.read()).rejects.toThrow(/upstream timeout after 10ms/);
  expect(canceled).toBe(true);
});

test("upstream timeout wrapper errors even if timeout fires before the first body read", async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5);
  const resp = new Response(new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  }));
  const wrapped = wrapResponseBodyWithUpstreamTimeout(resp, ctrl, timer, 5);

  await new Promise(resolve => setTimeout(resolve, 20));

  const reader = wrapped.body!.getReader();
  await expect(reader.read()).rejects.toThrow(/upstream timeout after 5ms/);
});

test("upstream timeout wrapper releases upstream reader when downstream cancels a pending read", async () => {
  let canceled = false;
  let cancelReason: unknown;
  let markPullStarted!: () => void;
  const pullStarted = new Promise<void>(resolve => { markPullStarted = resolve; });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      markPullStarted();
      return new Promise<void>(() => {});
    },
    cancel(reason) {
      canceled = true;
      cancelReason = reason;
    },
  });
  const resp = new Response(stream);
  const wrapped = wrapResponseBodyWithUpstreamTimeout(resp, ctrl, timer, 10_000);
  const reader = wrapped.body!.getReader();

  const pendingRead = reader.read();
  await pullStarted;
  await Promise.race([
    reader.cancel("client disconnected"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 200)),
  ]);
  const pendingResult = await Promise.race([
    pendingRead,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pending read timed out")), 200)),
  ]);

  expect(pendingResult.done).toBe(true);
  expect(canceled).toBe(true);
  expect(cancelReason).toBe("client disconnected");
  expect(ctrl.signal.aborted).toBe(true);
  expect(stream.locked).toBe(false);
});
