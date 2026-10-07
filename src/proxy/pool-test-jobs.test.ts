import { expect, test } from "bun:test";
import { sleep } from "../utils/sleep.js";
import { createProxyPoolTestJobs } from "./pool-test-jobs.js";
import type { PoolProxy } from "./pool-types.js";

type Controller = ReturnType<typeof createProxyPoolTestJobs>;

function proxy(id: string): PoolProxy {
  return { id, url: `http://${id}.example:8080`, source: "manual", addedAt: 123 };
}

function pendingProbe(abortable = true) {
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<AbortSignal>();
  const fetchImpl = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error("probe requires a cancellation signal");
    if (abortable) {
      signal.addEventListener("abort", () => response.reject(new Error("aborted")), { once: true });
    }
    started.resolve(signal);
    return response.promise;
  }, { preconnect() {} }) as typeof fetch;
  return { fetchImpl, started: started.promise, resolve: response.resolve };
}

async function waitForCompletion(controller: Controller) {
  for (let i = 0; i < 100; i++) {
    const state = controller.getTestJobState();
    if (state && !state.running) return state;
    await sleep(5);
  }
  throw new Error("proxy test job did not complete");
}

test("separate controllers do not share cancellation or polling results", async () => {
  const first = createProxyPoolTestJobs({ loadProxies: async () => [proxy("first")], removeFailedProxies: async () => 0 });
  const second = createProxyPoolTestJobs({ loadProxies: async () => [proxy("second")], removeFailedProxies: async () => 0 });
  const firstProbe = pendingProbe();
  const secondProbe = pendingProbe();
  try {
    await Promise.all([
      first.startTestJob({ fetchImpl: firstProbe.fetchImpl }),
      second.startTestJob({ fetchImpl: secondProbe.fetchImpl }),
    ]);
    const [firstSignal, secondSignal] = await Promise.all([firstProbe.started, secondProbe.started]);
    first.cancelTestJob();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(second.getTestJobState()?.running).toBe(true);

    secondProbe.resolve(new Response(null, { status: 204 }));
    const completed = await waitForCompletion(second);
    expect(completed.okCount).toBe(1);
    expect(Object.keys(completed.results)).toEqual(["second"]);
    expect(second.getTestJobState({ sinceSeq: completed.resultSeq })?.results).toEqual({});
  } finally {
    first.reset();
    second.reset();
  }
});

test("automatic removal delegates the original tested snapshot to the pool", async () => {
  const failed = proxy("failed");
  let removed: PoolProxy[] = [];
  const controller = createProxyPoolTestJobs({
    loadProxies: async () => [failed],
    removeFailedProxies: async snapshots => { removed = snapshots; return 1; },
  });
  const fetchImpl = Object.assign(async () => { throw new Error("connection refused"); }, { preconnect() {} }) as typeof fetch;
  try {
    await controller.startTestJob({ fetchImpl, autoRemove: true });
    const state = await waitForCompletion(controller);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(failed);
    expect(state.failCount).toBe(1);
    expect(state.removedCount).toBe(1);
  } finally {
    controller.reset();
  }
});

test("late completion of an old job cannot cancel a newer job's result cleanup", async () => {
  const previousTtl = process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
  process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = "50";
  let loads = 0;
  const controller = createProxyPoolTestJobs({
    loadProxies: async () => [proxy(++loads === 1 ? "old" : "new")],
    removeFailedProxies: async () => 0,
  });
  const oldProbe = pendingProbe(false); // Simulate a fetch implementation that resolves after abort.
  const newFetch = Object.assign(async () => new Response(null, { status: 204 }), { preconnect() {} }) as typeof fetch;
  try {
    await controller.startTestJob({ fetchImpl: oldProbe.fetchImpl });
    await oldProbe.started;
    controller.reset();
    await controller.startTestJob({ fetchImpl: newFetch });
    const state = await waitForCompletion(controller);
    expect(Object.keys(state.results)).toEqual(["new"]);

    oldProbe.resolve(new Response(null, { status: 204 }));
    await sleep(100);
    // Check the index before polling: getTestJobState itself can also prune expired results.
    expect(controller.resultOrderLength()).toBe(0);
    expect(controller.getTestJobState()).toBeNull();
  } finally {
    oldProbe.resolve(new Response(null, { status: 204 }));
    controller.reset();
    if (previousTtl === undefined) delete process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
    else process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = previousTtl;
  }
});
