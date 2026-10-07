/** Background proxy testing; owns job lifecycle but delegates pool reads/removals. */
import { createMutex } from "../utils/fs.js";
import { parseStrictNonNegativeInteger } from "../utils/numbers.js";
import { PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { hostClearTimeout, hostSetTimeout } from "../utils/host-timers.js";
import { wrapFetchWithSocksBridge } from "./proxied-fetch.js";
import { truncateProxyPoolError } from "./pool-source.js";
import type { PoolProxy } from "./pool-types.js";

const MAX_TIMER_MS = 2_147_483_647;

/**
 * State of a background test-all job. The job runs entirely on the server —
 * the dashboard starts it via POST /admin/api/proxy-pool/test-all and polls
 * GET /admin/api/proxy-pool/test-status for progress. Closing the browser
 * tab does NOT stop the job.
 */
export interface TestJobState {
  /** Whether the job is currently running. */
  running: boolean;
  /** Total proxies to test (captured at job start). */
  total: number;
  /** Number of proxies tested so far. */
  tested: number;
  /** Number of successful tests so far. */
  okCount: number;
  /** Number of failed tests so far. */
  failCount: number;
  /** Number of failed proxies auto-removed (0 if autoRemove is off). */
  removedCount: number;
  /** Batch size (concurrent tests per batch). */
  batchSize: number;
  /** Whether failed proxies are auto-removed after the job. */
  autoRemove: boolean;
  /** Job start time (Unix ms). */
  startedAt: number;
  /** Job finish time (Unix ms, set when job completes). */
  finishedAt?: number;
  /** Per-proxy results: { [proxyId]: { ok, latencyMs, status?, error? } }. */
  results: Record<string, { ok: boolean; latencyMs: number; status?: number; error?: string; seq?: number }>;
  /** Monotonic sequence assigned to test results, used for incremental polling. */
  resultSeq: number;
  /** Error message if the job itself failed (rare). */
  error?: string;
}

export function resolveTestJobResultTtlMs(raw = process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return PROXY_POOL_CONST.TEST_JOB_RESULT_TTL_MS;
  }
  const n = parseStrictNonNegativeInteger(raw);
  return n === undefined ? PROXY_POOL_CONST.TEST_JOB_RESULT_TTL_MS : Math.min(n, MAX_TIMER_MS);
}

interface TestJobDependencies {
  loadProxies(): Promise<PoolProxy[]>;
  removeFailedProxies(proxies: PoolProxy[]): Promise<number>;
}

/** One controller per pool. No reverse import of proxy-pool.ts is needed. */
export function createProxyPoolTestJobs(dependencies: TestJobDependencies) {
  const testJobMutex = createMutex();
  let currentTestJob: TestJobState | null = null;
  let currentTestJobAbort: AbortController | null = null;
  let currentTestJobResultIds: string[] = [];
  let currentTestJobCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  const DEFAULT_TEST_JOB_BATCH_SIZE = 5;
  const MIN_TEST_JOB_BATCH_SIZE = 1;
  const MAX_TEST_JOB_BATCH_SIZE = 50;

  function normalizeTestJobBatchSize(raw: unknown): number {
    if (raw === undefined || raw === null) return DEFAULT_TEST_JOB_BATCH_SIZE;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return DEFAULT_TEST_JOB_BATCH_SIZE;
    return Math.max(MIN_TEST_JOB_BATCH_SIZE, Math.min(MAX_TEST_JOB_BATCH_SIZE, raw));
  }

  function clearTestJobCleanupTimer(): void {
    if (!currentTestJobCleanupTimer) return;
    try { hostClearTimeout(currentTestJobCleanupTimer); } catch {}
    currentTestJobCleanupTimer = null;
  }

  function clearCompletedTestJob(job: TestJobState): void {
    if (currentTestJob !== job || job.running) return;
    currentTestJob = null;
    currentTestJobResultIds = [];
    if (currentTestJobAbort) {
      try { currentTestJobAbort.abort(); } catch {}
      currentTestJobAbort = null;
    }
    clearTestJobCleanupTimer();
  }

  function pruneExpiredTestJob(now = Date.now()): void {
    const job = currentTestJob;
    if (!job || job.running || job.finishedAt === undefined) return;
    const ttlMs = resolveTestJobResultTtlMs();
    if (ttlMs <= 0 || now - job.finishedAt >= ttlMs) {
      clearCompletedTestJob(job);
    }
  }

  function scheduleCompletedTestJobCleanup(job: TestJobState): void {
    if (currentTestJob !== job || job.running || job.finishedAt === undefined) return;
    // A late completion from a cancelled/reset job must not clear a newer job's timer.
    clearTestJobCleanupTimer();
    const ttlMs = resolveTestJobResultTtlMs();
    if (ttlMs <= 0) {
      clearCompletedTestJob(job);
      return;
    }
    const delay = Math.max(0, job.finishedAt + ttlMs - Date.now());
    currentTestJobCleanupTimer = hostSetTimeout(() => {
      if (currentTestJob === job) pruneExpiredTestJob();
    }, delay);
    if (typeof currentTestJobCleanupTimer.unref === "function") {
      currentTestJobCleanupTimer.unref();
    }
  }

  /** Get the current test job state (for polling). Null if no job has ever run. */
  function getTestJobState(options: { sinceSeq?: number } = {}): TestJobState | null {
    pruneExpiredTestJob();
    if (!currentTestJob) return null;
    const sinceSeq = Number.isFinite(options.sinceSeq) && options.sinceSeq !== undefined
      ? Math.max(0, Math.floor(options.sinceSeq))
      : undefined;
    if (sinceSeq !== undefined && sinceSeq >= currentTestJob.resultSeq) {
      return { ...currentTestJob, results: {} };
    }
    const results: TestJobState["results"] = {};
    if (sinceSeq !== undefined) {
      // Incremental polling should stay incremental. Scanning the full results
      // object on every dashboard poll made large proxy tests progressively
      // slower (N results × N polls). Result sequence numbers start at 1, so
      // slice(sinceSeq) returns ids whose seq is greater than sinceSeq.
      for (let i = sinceSeq; i < currentTestJobResultIds.length; i++) {
        const id = currentTestJobResultIds[i];
        const result = currentTestJob.results[id];
        if (!result || (result.seq ?? 0) <= sinceSeq) continue;
        results[id] = { ...result };
      }
      return { ...currentTestJob, results };
    }
    for (const [id, result] of Object.entries(currentTestJob.results)) {
      results[id] = { ...result };
    }
    return { ...currentTestJob, results };
  }

  function recordTestJobResult(
    job: TestJobState,
    proxyId: string,
    result: Omit<TestJobState["results"][string], "seq">,
  ): TestJobState["results"][string] {
    const withSeq = { ...result, seq: ++job.resultSeq };
    job.results[proxyId] = withSeq;
    if (currentTestJob === job) {
      currentTestJobResultIds.push(proxyId);
    }
    return withSeq;
  }

  /**
   * Start a background test-all job. If a job is already running, returns its
   * state without starting a new one (idempotent).
   *
   * The job runs fire-and-forget on the server. The caller gets back the
   * initial state immediately and can poll `getTestJobState()` for progress.
   *
   * @param options batchSize (1-50, default 5), autoRemove (default false),
   *                fetchImpl (for testing), testTarget (override target URL).
   * @returns The job state.
   */
  async function startTestJob(options: {
    batchSize?: number;
    autoRemove?: boolean;
    fetchImpl?: typeof fetch;
    testTarget?: string;
  }): Promise<TestJobState> {
    pruneExpiredTestJob();
    // Serialize the check-then-act: the running-job check used to straddle an
    // `await readPool()`, so two concurrent POST /test-all could BOTH pass it,
    // spawn parallel jobs, and orphan the first job's AbortController (leaving
    // it uncancellable). The job itself runs fire-and-forget outside the hold.
    return testJobMutex.run(async () => {
      // If a job is already running, return its state (don't start a duplicate).
      if (currentTestJob && currentTestJob.running) {
        return getTestJobState()!;
      }
      clearTestJobCleanupTimer();

      const proxies = await dependencies.loadProxies();
      const batchSize = normalizeTestJobBatchSize(options.batchSize);
      const autoRemove = options.autoRemove === true;
      const jobAbort = new AbortController();

      const job: TestJobState = {
        running: true,
        total: proxies.length,
        tested: 0,
        okCount: 0,
        failCount: 0,
        removedCount: 0,
        batchSize,
        autoRemove,
        startedAt: Date.now(),
        results: {},
        resultSeq: 0,
      };
      currentTestJob = job;
      currentTestJobAbort = jobAbort;
      currentTestJobResultIds = [];

      // Fire-and-forget — run the job in the background. Errors are captured
      // into job.error so the dashboard can surface them.
      runTestJob(job, proxies, options.fetchImpl ?? fetch, options.testTarget, jobAbort.signal)
        .catch(e => {
          job.error = (e as Error).message;
          job.running = false;
          job.finishedAt = Date.now();
        })
        .finally(() => {
          if (currentTestJob === job && currentTestJobAbort === jobAbort) {
            currentTestJobAbort = null;
          }
          if (!job.running && job.finishedAt === undefined) {
            job.finishedAt = Date.now();
          }
          scheduleCompletedTestJobCleanup(job);
        });

      return getTestJobState()!;
    });
  }

  /**
   * Internal: run the test job. Processes proxies in batches of `batchSize`,
   * updating `job` in real-time so pollers see progress. After all batches
   * complete, auto-removes failed proxies if `autoRemove` is true.
   */
  async function runTestJob(
    job: TestJobState,
    proxies: PoolProxy[],
    fetchImpl: typeof fetch,
    testTargetOverride?: string,
    jobSignal?: AbortSignal,
  ): Promise<void> {
    const failedProxies: PoolProxy[] = [];
    const total = proxies.length;
    // Wrap fetchImpl once so every proxy in the batch (HTTP, HTTPS, or SOCKS)
    // is handled correctly. SOCKS proxies are transparently routed through
    // the local HTTP-CONNECT→SOCKS bridge (Bun's native fetch would otherwise
    // throw UnsupportedProxyProtocol for socks4:// / socks5:// schemes).
    const wrappedFetch = wrapFetchWithSocksBridge(fetchImpl);

    for (let i = 0; i < total; i += job.batchSize) {
      // If job was cancelled (a new job started), stop early.
      if (!job.running || jobSignal?.aborted) {
        job.running = false;
        job.finishedAt ??= Date.now();
        return;
      }

      const batch = proxies.slice(i, i + job.batchSize);
      const promises = batch.map(async p => {
        if (!job.running || jobSignal?.aborted) return;
        const target = testTargetOverride ?? "https://api.z.ai";
        const started = Date.now();
        const ctrl = new AbortController();
        const timer = hostSetTimeout(() => ctrl.abort(), 10_000);
        if (typeof timer.unref === "function") timer.unref();
        const onJobAbort = () => ctrl.abort();
        if (jobSignal) {
          if (jobSignal.aborted) ctrl.abort();
          else jobSignal.addEventListener("abort", onJobAbort, { once: true });
        }
        try {
          const resp = await wrappedFetch(target, {
            method: "HEAD",
            signal: ctrl.signal,
            redirect: "follow",
            ...(p.url ? { proxy: p.url } : {}),
          });
          const latencyMs = Date.now() - started;
          try { await resp.body?.cancel(); } catch {}
          if (!job.running || jobSignal?.aborted) {
            recordTestJobResult(job, p.id, { ok: false, latencyMs, error: "Test cancelled" });
            return;
          }
          recordTestJobResult(job, p.id, { ok: true, latencyMs, status: resp.status });
          job.okCount++;
        } catch (err) {
          const latencyMs = Date.now() - started;
          const rawErrMsg = (err as Error).message || String(err);
          if (!job.running || jobSignal?.aborted) {
            recordTestJobResult(job, p.id, { ok: false, latencyMs, error: "Test cancelled" });
            return;
          }
          const isTimeout = ctrl.signal.aborted || /abort/i.test(rawErrMsg);
          recordTestJobResult(job, p.id, { ok: false, latencyMs, error: isTimeout ? "Connection timed out after 10s" : truncateProxyPoolError(rawErrMsg) });
          job.failCount++;
          failedProxies.push(p);
        } finally {
          hostClearTimeout(timer);
          if (jobSignal) jobSignal.removeEventListener("abort", onJobAbort);
          job.tested++;
        }
      });
      await Promise.all(promises);
    }

    if (!job.running || jobSignal?.aborted) {
      job.running = false;
      job.finishedAt ??= Date.now();
      return;
    }

    // Auto-remove failed proxies if enabled.
    if (job.autoRemove && failedProxies.length > 0) {
      job.removedCount = await dependencies.removeFailedProxies(failedProxies);
    }

    job.running = false;
    job.finishedAt = Date.now();
  }

  /** Cancel the current test job (if any). The job stops after the current batch. */
  function cancelTestJob(): void {
    currentTestJobAbort?.abort();
    if (currentTestJob) {
      currentTestJob.running = false;
      currentTestJob.finishedAt ??= Date.now();
      scheduleCompletedTestJobCleanup(currentTestJob);
    }
  }

  function reset(): void {
    clearTestJobCleanupTimer();
    currentTestJob = null;
    currentTestJobAbort?.abort();
    currentTestJobAbort = null;
    currentTestJobResultIds = [];
  }

  return {
    startTestJob,
    getTestJobState,
    cancelTestJob,
    reset,
    resultOrderLength: () => currentTestJobResultIds.length,
  };
}
