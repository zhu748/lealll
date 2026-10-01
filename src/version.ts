/**
 * Runtime version marker for the fork-merged build.
 *
 * Upstream base: TriDefender/zcode-api v4.7.2 (claim / MCP / TUI / captcha
 * worker architecture). Fork layer: zhu748/lealll multi-account store +
 * web dashboard + proxy pool + retry resilience (v0.3.10.11 lineage).
 *
 * v4.7.6-fork.1 (hardening release): repo-wide resilience & security pass.
 * Deterministic serve() startup-failure exit; graceful shutdown drains the
 * buffered file log (second signal force-exits). Credentials store migration
 * is now serialized against concurrent writers (deadlock-safe, skips when a
 * newer v2 store already persisted). CSRF cross-origin mutation guard shared
 * by /admin/api/* and /quota/*; CSP allowlists the two CDNs the webui loads.
 * Android: network_security_config.xml replaces blanket cleartext traffic;
 * duplicate nested Android-APP/Android-APP tree and dead OAuthWebViewActivity
 * removed. Proxy handler guard/telemetry hardening (+ handler-guards tests).
 *
 * v4.7.5-fork.1 (desktop 3.14.4 alignment, supplemental): added MCP usage
 * quota query (`/api/v1/mcp/usage`), remote provider config delivery
 * (`/api/v1/client/configs`), subscription availability probe
 * (`/api/biz/subscription/list`). GET /quota now returns `mcpUsage` +
 * `subscriptionAvailability` fields alongside the existing balances /
 * codingPlan / claimablePlans. All four supplemental planes fail-open
 * (null / kind:"unknown") to match the desktop's tolerance.
 *
 * The dashboard replaces `__ZCODE_PROXY_VERSION__` with this value.
 */
export const VERSION = "4.7.6-fork.1";
