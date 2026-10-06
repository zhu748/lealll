/**
 * Stable public entry point for the admin dashboard.
 * HTTP dispatch lives in router.ts; each feature owns its state and routes.
 * Keep these exports compatible with server, proxy, CLI and existing tests.
 */
export { clearDebugDumps, recordDebugDump } from './debug-dumps.js';
export {
  _flushLogFileForTesting,
  _logFileFlushStateForTesting,
  _logWaiterCountForTesting,
  _resetLogFileForTesting,
  _setLogFileAppendForTesting,
  _setLogStreamBackpressureLimitForTesting,
  appendLog,
  flushLogFileForShutdown,
  setLogFilePath,
} from './logs.js';
export {
  _activeOAuthFlowCountForTesting,
  _hasActiveOAuthFlowForTesting,
  _rememberActiveOAuthFlowForTesting,
  _resetActiveOAuthFlowsForTesting,
} from './oauth.js';
export {
  _probeStartPlanActivationForTesting,
  _quotaCacheStateForTesting,
  _resetQuotaCacheForTesting,
} from './quota.js';
export { setAdminBodyIdleTimeoutForTesting as _setAdminBodyIdleTimeoutForTesting } from './request-body.js';
export { getDashboardHTML, handleAdminRoute } from './router.js';
export { _resetStatsForTesting, recordStat } from './stats.js';
export type { AdminOptions } from './types.js';
