# zcode-proxy

A reverse proxy for Z.AI / Bigmodel.cn coding-plan APIs that exposes both OpenAI-compatible and Anthropic-format endpoints.

## v0.3.8.0 — Dashboard cleanup (legacy captcha page removed, pool health on Overview)

The dashboard still carried a 验证码助手 (Captcha Helper) page — a leftover
from the pre-v0.3.0 Chrome CDP solver. Since v0.3.0 replaced that solver with
the fully automatic in-process happy-dom token pool, the page rendered only
dead data: it displayed Chrome-era fields (模式/验证次数/Keepalive/SDK/
Chrome 路径/端口/窗口/交互次数) that never exist in the pool-backed API
response — 模式 permanently "单次", 验证次数 permanently "0", the detail
card permanently all-dashes. Its "停止" button was worse than useless: it
shut down the production token supply (stopCaptchaPool), after which
start-plan requests had to fall back to slow on-demand solves.

Removed and replaced:

- **Deleted**: the 验证码助手 nav item, page, all its JS (load/warmup/stop/
  in-flight coalescing/invalidate hooks), and the three backend routes
  (`GET /admin/api/captcha-helper`, `POST .../warmup`, `POST .../stop`).
- **Deleted**: the `ChromeCaptchaHelper*` shims in `src/proxy/captcha.ts`
  (the happy-dom pool needs no manual control — boot pre-solve + demand
  refill are fully automatic; process-exit cleanup now calls
  `shutdownCaptcha()` directly).
- **Added**: pool health now rides on the existing `/admin/api/stats`
  snapshot as a read-only `captchaPool` field (`ready/target/activeSolves`)
  — no separate polling loop, no mutation surface. The Overview page
  renders it as a new 验证码池（就绪/目标）stat card; it shows an em dash
  while the pool is not configured (coding-plan, or start-plan before the
  first login starts the pre-solver).
- Android `server.cjs` bundle regenerated from the updated sources.

Tests updated to pin the removal (routes fall through to null; the page and
its JS are absent from the dashboard HTML) and the new stats field.

## v0.3.7.1 — 429-retry permanent hang fix (host timer quarantine)

Reported 2026-08-27: a start-plan request hit 429 and the proxy logged
`upstream returned 429, retry 1/20 in 247ms..` — then hung forever with no
further output. The client waited indefinitely.

Root cause (empirically reproduced with real happy-dom windows,
`scripts/probe_timer_cancel.ts`): under Bun, captcha guest scripts run in
the host realm, so `installGlobalWindowAlias()` shadows the global
`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` with the solving
window's timer registry. While ANY solve epoch is active (background pool
refill waves run almost continuously under load), host code resolving the
bare `setTimeout` identifier got the WINDOW's registry instead. Timers
registered there are silently CANCELLED when the window is closed
(`happyDOM.close()` aborts its TimerManager). Three host guards died this
way, so nothing in the chain could ever recover:

1. The retry backoff `sleep(247)` — cancelled mid-sleep → the exact
   reported hang (log stops right after the retry line).
2. The token pool's 25s take deadline and 10s grace loop — cancelled →
   `takeCaptchaToken` never returned.
3. `solveTraceless`'s own 30s timeout guard and stall detector — registered
   on a window registry (a SIBLING window's, under concurrent solves — the
   alias aims at the last-installed window) → cancelled by that window's
   close → the solve promise never settled.

Fix — host timer quarantine (`src/utils/host-timers.ts`):

- Host code never resolves timers through an aliased globalThis. Each
  `hostSetTimeout`/`hostSetInterval`/`hostClearTimeout`/`hostClearInterval`
  call resolves its binding by descriptor shape: ACCESSOR (the only form
  the alias installs) ⇒ the native binding captured at module load (Bun
  natives are data properties; the capture is guaranteed pre-alias because
  captcha-happy.ts — the only alias installer — imports host-timers at its
  top); DATA (native, or a test stub) ⇒ the current global value. This
  keeps the existing test suite's `globalThis.setTimeout = wrapper`
  interception working unchanged.
- All host-side timer call sites migrated (sleep, retry loop, upstream
  fetch abort guards, SSE heartbeat + backpressure yields, token pool
  deadline/grace/stagger/refill, CPU governor, SOCKS bridge, proxy pool,
  auth timeout guards, admin body/log/SSE timers, boot/exit timers).
- Guest-facing polyfills (`requestIdleCallback`, `requestAnimationFrame`)
  and `simulateBehavior` now bind to their OWN window's `w.setTimeout`
  (previously they resolved through the alias to the LAST-installed
  window — a sibling's registry — under concurrent solves).
- Hardened the alias epoch refcount: a double `destroyDom` (reuse path)
  used to drive it negative, after which the next install ran with an
  EMPTY descriptor snapshot and the HOST_CRITICAL_GLOBALS check failed
  open — shadowing `console`/`process`/`fetch`/`crypto` with window
  getters (server-wide catastrophe; observed as install hangs once the
  aliased console was used). The refcount now clamps at zero and installs
  self-heal.

Pinned by 8 unit tests (`host-timers.test.ts` descriptor-resolution rules)
and 5 real-window regression tests (`captcha-happy.test.ts`: backoff sleep
survives window destruction, sibling mid-epoch destruction, solve-guard
survival, double-destroy recovery). Full suite 1251/1251; real-solve E2E
smoke passes with concurrent host sleep surviving the epoch.


## v0.3.7.0 — start-plan endpoint fixed (zcode.z.ai removed the OpenAI gateway)

Reported against v0.3.6.2: every start-plan request failed with
`upstream 404 404 page not found` — the account, JWT, captcha, and identity
fingerprint were all fine; the model request was simply hitting a dead route.

Live-probed the zcode.z.ai gateway directly:

| Path | Status | Meaning |
|------|--------|---------|
| `POST /api/v1/zcode-plan/chat/completions` | **404** `404 page not found` | route REMOVED server-side (Go default mux 404) |
| `POST /api/v1/zcode-plan/anthropic/v1/messages` | **401** | route ALIVE, auth-gated |
| `GET /api/v1/zcode-plan/billing/balance` | 401 | quota endpoints unaffected |

The OpenAI gateway path (adopted in v0.3.0 from upstream zcode-api v2.6.0)
was removed server-side around 2026-08-27. Upstream zcode-api's master has
the same dead URL hardcoded — their start-plan path is equally broken (no
issue filed there as of 2026-08-27); this fix leads upstream by a full
endpoint flip.

**Fix**: start-plan now routes through the Anthropic mirror
`/api/v1/zcode-plan/anthropic/v1/messages` (the pre-v0.3.0 behavior,
restored):

- Both plans now speak the Anthropic upstream — start-plan reuses the
  battle-tested coding-plan pipeline (wire-shape alignment, SSE→batch
  folding, session-context, SSE error detection) instead of the gateway
  translation pipeline.
- Auth is `Authorization: Bearer <jwt>` + `anthropic-version` — the header
  builder already supported this combination (it was the pre-v0.3.0 path).
- The body-transformer's start-plan system blocks (`applyStartPlanSystem`:
  zcode_system.json blocks + dynamic model line, the gateway 3012 content
  check) were never removed — they activate again automatically.
- Captcha preflight / 3007 challenge / retry semantics are unchanged.
- **Escape hatch**: the server flipped endpoints once already, so the legacy
  gateway pipeline is kept behind `ZCODE_STARTPLAN_UPSTREAM=openai`. If the
  gateway endpoint ever returns, users flip back without a new release.

Verified end-to-end against the live gateway with the compiled binary:

- Default: start-plan request reaches the mirror and gets **401** with a
  fake JWT (`start_plan_jwt_invalid` — route exists, auth processed).
- `ZCODE_STARTPLAN_UPSTREAM=openai`: byte-for-byte reproduces the user's
  `upstream 404 404 page not found` (A/B control confirming the diagnosis).

Tests: 1261/1261 (+3: mirror routing e2e, anthropic-client passthrough
regression for the exact user scenario, escape-hatch guard; plus a new
start-plan anthropic header-order test). tsc clean; linux-x64 compile smoke
passed.

## v0.3.6.2 — OAuth Login Hang Fixed (mint breaker, solve backoff, login-first startup)

Reported against v0.3.6.x: clicking "开始登录" in the dashboard hung at
"初始化中..." until the 15s frontend timeout. Root cause found by
instrumenting a live repro: `POST /admin/api/oauth/init` itself is trivial
(bind a loopback port + build a URL — the handler finishes in ~20ms), but the
**captcha pre-solver's happy-dom solves starve the shared event loop**. Each
solve contains multi-hundred-ms synchronous eval chunks; when mints fail
persistently (flagged IP / WAF degrade / FeiLin fingerprint failures) the
pool NEVER stops retrying — measured event-loop stalls of **4–5.7 seconds**
repeating forever. A multi-turn request (body stream read → node:http
listen → response write) cannot thread through those stalls; the response
write wedges for 35–90s while single-turn endpoints (status pings) squeak
through between stalls. On the user's machine the same spiral produced the
earlier `L[$]` spam — that noise was the audible symptom of failing mints.

Four-layer fix (1258/1258 tests, +7; end-to-end verified on a live server):

- **Mint circuit breaker** (`captcha-pool.ts`): two consecutive all-failed
  solve waves now park background solving for an escalating cooldown
  (30s → 60s → 120s → 300s → 600s, any banked token resets the ladder).
  The startup `prefill` loop also exits when parked — previously a broken
  mint environment spun failed waves FOREVER at full CPU. On-demand solves
  for live user requests still run while parked.
- **Exponential backoff inside a solve retry chain** (500ms → 4s cap):
  four attempts used to run back-to-back, each burning seconds of
  synchronous eval. Env-tunable (`CAPTCHA_SOLVE_BACKOFF_BASE_MS/CAP_MS`),
  0 disables.
- **Background wave concurrency capped at 2** (urgent waves keep the full
  governor allowance). A full-throttle 8-wide background fill made the
  admin API chunky even when mints succeed.
- **Login-first startup**: fresh oauth installs (zero stored accounts) now
  DEFER the pre-solver entirely — nothing can consume tokens before the
  first credential exists, and login runs on an idle loop. The pool starts
  lazily right after the first start-plan login saves its credential. For
  configured installs the pre-solver boots after a 10s idle-loop grace
  (`CAPTCHA_PRESOLVER_DELAY_MS`, 0 = immediate) so the first dashboard
  interactions stay snappy, and Bun's node:http machinery is pre-warmed at
  boot (the first `listen()` under load could wedge the in-flight response
  write for 10–25s — observed, reproduced, closed).

Validated on a live server across the full pool lifecycle (grace window →
fill → keeper churn → expiry refill): 20/20 oauth/init calls returned in
11ms–852ms (pre-fix: 6.5s → 35s → 90s+ timeouts).

## v0.3.6.1 — Zero-Spam Startup (guest rejection routing, console probe filter)

Reported against the v0.3.6.0 Windows exe: opening the app still flooded
the terminal with `[unhandledRejection] TypeError: L[$] is not a function`
stacks from the FeiLin captcha chunk (`getUniversalCombatFeature`), plus
stray `%c%d` / `NaN` / `undefined` lines. Root-caused to THREE leak paths
that all bypass the v0.3.6.0 guest-window collectors — every one reproduced
locally (the user's exact feilin149.js:1:220532 stack fires in a parallel
solve wave), every one fixed with regression tests (1251/1251 green, +13):

- **Guest-origin rejections escaped to the process level**. FeiLin races
  dozens of best-effort async fingerprint collectors inside promises with
  NO catch handlers. Under Bun the guest scripts run in the host realm, so
  their rejections reached the generic `[unhandledRejection]` printer in
  index.ts. New conservative classifier (`captcha-guest-rejections.ts`): a
  rejection is guest-origin only if a **stack frame** (never the message)
  points at an alicdn.com guest chunk — a host `fetch()` failure that
  merely mentions an alicdn URL in its message still prints. Guest
  rejections are collected into a bounded ring (40, tail-kept) and surface
  ONLY when a solve FAILS (attached as `hostUH[…]` next to `guestErrors[…]`
  — self-diagnosing failures, quiet successes).
- **Getter-probe promise leak in `installNativeToString`**. The
  fingerprint-masking sweep probes every getter with the target as
  receiver; stream reader/writer `closed` / `ready` getters brand-check
  `this` by REJECTING a promise (not throwing), so each sweep leaked four
  more `[unhandledRejection] TypeError: The ReadableStreamBYOBReader.closed
  getter …` lines. Probes now attach a no-op catch to whatever the getter
  returns.
- **FeiLin's console-surface probe printed through the host console**. The
  SDK iterates `[log, dir, dirxml, table, count, …].forEach(fn => fn(…))`
  from guest frames (a headless-detection fingerprint), and under Bun bare
  `console` resolves to the HOST console — hence the stray `%c%d` /
  `NaN` / `undefined` lines per solve. During a solve epoch
  `globalThis.console` is now swapped for a delegating wrapper that drops
  calls with an alicdn frame in the top of the stack; host logging passes
  through untouched (the dashboard LogBuffer interceptor keeps capturing
  it), wrapped methods are masked as `[native code]` (so a
  `console.log.toString()` probe still sees a native shape), and the true
  console is restored when the last concurrent window is destroyed.

Validated end-to-end: a parallel solve wave + sequential refills all mint
valid 280-char verify params with a **completely clean terminal** — zero
`[unhandledRejection]`, zero `[WINDOW-ERROR]`, zero console noise.

## v0.3.6.0 — Captcha Solver Fixes (print alias, host-timer survival, quiet solves)

Reported against the v0.3.5.0 Windows exe: opening the app with a
start-plan credential flooded the terminal with
`[WINDOW-ERROR] print is not defined ReferenceError` from the Aliyun FeiLin
captcha script. Root-caused to the happy-dom global-alias machinery (present
verbatim in upstream too) — two real bugs, both fixed and pinned by
regression tests:

- **`print` alias gap (the reported error)**. Under Bun, guest script tags
  execute in the HOST realm, so FeiLin's bare `print()` resolved against
  `globalThis` — and `print` was excluded from aliasing on the assumption
  Bun ships a `print()` global (it does not, verified on Linux and Windows).
  Every solve aborted FeiLin event listeners mid-collection with
  ReferenceError. Host-critical names are now only protected when the host
  actually defines them (per-epoch descriptor snapshot), so the window's
  polyfilled `print` (and any other non-host critical global) resolves
  exactly as in a real browser realm.
- **Host timer deletion (latent server breaker)**. The alias cleanup blindly
  deleted every aliased name — including `setTimeout` / `setInterval` /
  `clearTimeout` / `clearInterval`, which happy-dom's window also owns. After
  the last solve's window destruction, any server-side timer call (SSE
  heartbeat, retry backoff, graceful shutdown) threw
  `setTimeout is not defined`. Cleanup now restores the snapshotted host
  descriptors (and removes the previously-leaking `__capWindowFor` getter
  that kept destroyed windows alive).
- **Quiet solves, self-diagnosing failures**. A single solve wave used to
  print dozens of `[WINDOW-ERROR]` / `[UH-REASON]` lines to the console.
  Guest-realm errors are now collected silently (most-recent 40) and
  attached to the error message when a solve FAILS — set
  `CAPTCHA_GUEST_DEBUG=1` for live forensics printing.
- Polyfilled window methods (`print`, `alert`, `open`, …) are now defined
  with `enumerable: true`, matching real browser property descriptors (a
  non-enumerable `window.print` is itself a headless tell).

Validated end-to-end: a real network solve mints a valid 280-char verify
param with zero error spam; `tsc` clean; 1238/1238 tests (+6 regression
tests for the alias epoch lifecycle and guest-error collection).

## v0.3.5.0 — Out-of-Box Defaults (oauth-first, glm-5.3, no key-length gate)

Three packaging gaps reported against the v0.3.4.0 Windows zip — all
fixed at the template/loader level so both fresh downloads and `init`-
generated configs pick them up.

- **`auth.proxyApiKey` no longer enforces an 8-character minimum.** The
  old hard error (`must be at least 8 characters`) blocked startup for
  users who deliberately want a short personal key on a loopback/LAN
  deployment. Any non-empty key now loads; the empty value keeps its
  "loopback-only admin" meaning. A non-blocking startup NOTE (with
  brute-force advice when bound to 0.0.0.0) replaces the hard gate —
  the owner decides, the proxy advises.
- **Shipped `config.yaml` now defaults to `mode: oauth` + `provider: zai`.**
  OAuth is the primary flow for a coding-plan proxy (login once, refresh
  forever); the old template defaulted to `apikey` with a placeholder
  upstream key, which made first run fail confusingly. The server already
  starts fine in oauth mode before login (API calls 503, dashboard offers
  OAuth login / ZCode import with hot-swap), so the new default is a
  download → run → click-login experience. `apikey` mode is unchanged and
  still fully supported.
- **`glm-5.3` added to the shipped model list.** The registry has had it
  since v0.3.2, but the template's `models:` array (which overrides the
  registry when set) still listed 9 models — fresh installs showed
  "models: 9 available" and no glm-5.3. The template now lists all 10
  models; a regression test pins template mode/provider/model-count so
  this drift can't happen again.

## v0.3.4.0 — Client-Disconnect Propagation + Dual Server Adapter

A deep audit of the v0.3.3.0 node:http migration surfaced one critical
runtime gap and two latent resource bugs — all fixed and regression-tested
(1230/1230 green, +6 tests).

- **Client disconnects now cancel upstream work (quota saver)**. When a
  client vanishes mid-request (Ctrl+C on Claude Code, SDK timeout, tab
  closed), the proxy now aborts the in-flight upstream fetch **immediately**
  and returns 499 `client_disconnected` instead of letting the generation
  run to completion for a response nobody will read. The abort also skips
  the retry loop (checked at loop top AND after every backoff sleep — a
  disconnect during backoff previously burned one extra attempt per retry)
  and stops WAF proxy-rotation early.
- **Dual server adapter — `Bun.serve` on Bun, `node:http` on Node
  (Android)**. The v0.3.3.0 migration put every runtime on `node:http`,
  which silently lost disconnect detection on desktop: Bun's `node:http`
  compat layer emits **no events at all** (no `res 'close'`, no `req
  'aborted'`, not even socket `'close'` on a raw TCP RST) once a request
  body has been consumed — verified empirically on Bun 1.3.14. The proxy
  was structurally blind to disappearing clients. Desktop builds are back
  on `Bun.serve` (native `req.signal` abort + auto stream cancellation);
  the Android bundle keeps `node:http` (real Node emits `res 'close'`
  correctly) with triple disconnect listeners. Routing, CORS, admin
  dashboard, timeouts: identical on both adapters.
- **Backpressure pump hang fix (`node:http` adapter)**: when a streaming
  client disconnected while the write buffer was full, the pump awaited a
  `drain` event that Node never emits on a destroyed socket — the closure
  (plus its buffers) hung forever, one leak per aborted stream. The wait
  now also resolves on `'close'`, and the trailing `res.end()` is
  exception-guarded. A post-listen `server.on("error")` logger was also
  added (an unhandled server error is process-fatal in Node).
- **Android OAuth client fingerprint**: the control listener's
  `startOAuth` built OAuth clients *without* the identity parameter, so the
  Android token exchange went out with Node's bare UA — the exact WAF
  fingerprint gap v0.3.2 fixed for desktop. The control protocol now
  carries the full ZCode client identity (config.yaml identity > env
  override > built-in defaults), and the control request body is capped at
  1MB (was unbounded).

## v0.3.3.0 — Android APK Support (upstream parity)

The server core now runs on **both Bun and Node**, unlocking the Android
build — the last upstream release artifact this fork was missing.

- **`server.ts` migrated from `Bun.serve` to `node:http`** (pattern from
  upstream): the same code now serves on Bun (dev/compiled binaries) and on
  Node (Android bundle). Client IP resolution moved from `Bun.serve#requestIP`
  to the node socket's `remoteAddress` (stashed per-request); idle-timeout
  semantics preserved (600s request/headers caps, 120s keep-alive, 24h socket
  timeout for `/async/*` off-peak waits); graceful stop keeps the old
  `stop(force)` contract. The full admin dashboard, CORS allowlist, async
  bridge, and per-route behavior are unchanged — 1224/1224 tests green.
- **Android app ported** (`Android-APP/`, aligned with upstream): Kotlin shell
  (foreground service + embedded WebView OAuth) launching the server as an
  esbuild Node CJS bundle on libnode.so (Termux-derived, arm64-v8a). The
  localhost control listener (`src/android/control.ts`) drives
  start/stop proxy, OAuth code delivery, config updates, log polling, and
  shutdown; the OAuth callback port is now fixed via `ZCODE_OAUTH_CALLBACK_PORT`
  so WebView redirects are predictable.
- **Node runtime hardening**: `ensureNodeFetchNoTimeouts()` (undici global
  dispatcher) disables Node fetch's default 300s headers/body timeouts that
  kill deep-reasoning streams on Android; entry detection switched to
  `require.main === module` (esbuild compiles `import.meta` to `{}` in CJS
  output, which silently disabled the bundled entry — caught by the new
  Node-execution smoke in CI); the gzip fallback path now uses `node:zlib`
  instead of `Bun.gzipSync`.
- **Release pipeline**: a new `android` job builds the APK
  (`zcode-proxy-android-v{V}.apk`) on every release — debug-signed by default,
  release-signed automatically when the `ANDROID_KEYSTORE_*` secrets exist.
  CI includes a Node-side bundle-execution smoke before gradle.
- **Known limitation**: the SOCKS proxy bridge is Bun-only by design; on the
  Android build a configured `socks://` proxy fails loudly with a clear error
  (never silently falls back to a direct connection — that would leak the
  user's real IP). `http(s)://` proxies are unaffected.

## v0.3.2 — Upstream Re-audit + OAuth Exchange Fingerprint

Full re-audit against upstream `TriDefender/zcode-api` master (32d508d,
2026-08-24 — no new upstream commits since the v0.3.1 alignment):
OAuth protocol constants, identity header sequence, all routes, the async
bridge semantics, and zcode_system.json are all confirmed aligned; upstream's
remaining modules (MCP, Android, node-fetch-compat, webui) stay deliberately
unported (dormant / N/A / superseded by the admin dashboard).

- **New model: `glm-5.3`** (1M context, 128K output) added to the pinned
  catalog — the only real upstream gap found in the re-audit. The admin
  dashboard's model datalist picks it up automatically.
- **OAuth token-exchange requests now carry the real-client identity
  headers** (`User-Agent: ZCode/<ver>`, `X-ZCode-App-Version`, `X-Title`,
  `X-ZCode-Agent: glm`, platform headers, …). Previously the exchange POST
  to `zcode.z.ai/api/v1/oauth/token` went out with a bare `Bun/x` UA — the
  same non-official-client fingerprint the v0.3.1 quota fix removed. The
  identity comes from the loaded config (env > YAML > defaults); the CLI
  `auth login` flow gets a new `resolveDefaultIdentity()` fallback so it
  stays fingerprinted even without a config.yaml. Both providers (zai /
  bigmodel), all three flows (dashboard poll, dashboard manual callback,
  CLI) are covered.
- Backward compatible: constructing an OAuth client without an identity
  keeps the old header shape (tests pin both behaviors).
- **Multi-platform releases (upstream alignment)**: GitHub Actions now
  cross-compiles and publishes 5 per-platform zips —
  `windows-x64` / `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`,
  each containing the binary + `config.yaml` + start script + user manual —
  plus a multi-arch Docker image on `ghcr.io/{owner}/zcode-proxy`.
  `start.sh` now auto-detects the platform binary (the old version tried to
  exec the Windows `.exe` on Unix, which never worked outside WSL).
  The upstream Android APK is not ported yet: it requires the server layer
  to run on `node:http` (libnode), while this fork's core is `Bun.serve` +
  a SOCKS bridge on `Bun.listen/connect` — see release.md for the roadmap.

## v0.3.1 — ZCode 3.9.2 + Off-Peak (错峰) Async Bridge

- **appVersion default 3.9.1 → 3.9.2** (ZCode release 2026-08-26). The
  billing `app_version` gate for first-time start-plan trial activation is
  version-sensitive — being even one minor behind can matter on fresh
  accounts, so the default now tracks the current client release.
- **Quota/billing requests now carry the full real-client identity header
  set** (`User-Agent: ZCode/<ver>`, `X-ZCode-App-Version`, `X-Title`, platform
  headers, …) instead of a bare `Authorization` header. A UA-less billing
  request is a fingerprint no real ZCode client ever produces and an easy
  WAF flag on zcode.z.ai. Applies to both the dashboard quota button and
  the background start-plan activation probe fired right after a credential
  is saved — “OAuth done = free trial activated” now also looks like a real
  client doing it.
- **Off-peak (错峰算力) async bridge** (upstream commit 175ff2a, ZCode 3.8.1+
  feature: GLM Coding Plan subscribers get a 5-hour quota reset during
  off-peak compute hours). Opt-in via `async.enabled: true` or
  `ZCODE_ASYNC_ENABLED=1`, then point clients at:
  - `POST /async/v1/messages` (Anthropic format)
  - `POST /async/v1/chat/completions` (OpenAI format)
  - `GET /async/v1/health` (probe queue availability)

  The proxy takes an off-peak ticket, holds the client connection open with
  SSE keepalive comments while queued, auto-retries on ticket expiry
  (default 3), then streams the LLM response through once the ticket is
  ready. Requires an OAuth / ZCode-imported account (JWT); apikey-only
  accounts get `400 async_credentials_unavailable`. Non-stream requests are
  internally forced to stream and re-aggregated into one JSON document with
  leading whitespace to defeat client TCP idle timeouts.
- Deliberately NOT ported from upstream: the MCP/GLM-tools module (dormant —
  not wired into any request path upstream), the Android control entry
  (Android-only deployment), `runtime/node-fetch-compat` (Node/undici fix —
  this repo is Bun-only), and `proxy/dump.ts` (superseded by the in-memory
  admin debug-dumps ring buffer).

## v0.3.0 — Upstream zcode-api v2.6.0 Alignment (free/start-plan tier support)

This release aligns the fork with the actively-maintained upstream
[TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) (v2.6.0,
2026-08) while keeping every fork-exclusive feature. The headline change:
**the free start-plan tier now works** — the upstream gateway requires an
Aliyun captcha token on every request, and the old jsdom/Chrome-CDP solver
was detectable by the risk engine. Replaced by the upstream battle-tested
in-process **happy-dom solver + pre-solved token pool**.

What's new (from upstream):

- **Captcha token pool** — tokens are pre-solved in the background (happy-dom
  in-process solver, deterministic fingerprints, no browser/jsdom dependency);
  each start-plan request takes an already-solved token in sub-millisecond
  time. CPU-governed, demand-driven pool sizing, F008 duplicate protection.
- **start-plan routes through the zcode.z.ai Anthropic mirror**
  (`/api/v1/zcode-plan/anthropic/v1/messages`, v0.3.7) — the OpenAI gateway
  path (`/api/v1/zcode-plan/chat/completions`) was removed server-side on
  2026-08-27 and now 404s. OpenAI-format clients are translated both ways;
  `ZCODE_STARTPLAN_UPSTREAM=openai` restores the legacy gateway pipeline.
- **Session-context inference** — replicates ZCode's single-user-identity
  UUID generation: multi-turn conversations reuse the same upstream
  `x-session-id` (explicit client headers or conversation-lineage hashing),
  plus `x-zcode-session-type` attribution on every model request.
- **V4 client request signing** — Ed25519 + proof-of-work signing for
  coding-plan requests when the server-side feature gate enables it
  (fail-open ladder, start-plan exempt).
- **Server-side endpoint routing** — remaps coding-plan endpoints per the
  server-published mapping table (ultra endpoints), fully fail-open.
- **Refreshed identity headers** — the full `pio` header set (X-Release-Channel /
  X-Client-Language / X-Client-Timezone / X-Os-* / X-Device-Mid) on model
  requests, refreshed against the 2026-08 bundle RE; appVersion default
  3.2.5 → 3.9.1.
- **Updated ZCode gateway system blocks** — new harness text, Environment
  Info block, and the dynamic `- You are powered by the model named X.` line
  (the gateway's content check rejects requests without them, 3012).

Fork-exclusive features kept intact: multi-account credential pool with
automatic switching, admin dashboard (40 endpoints), global proxy pool +
SOCKS bridge, WAF detection with proxy rotation, SSE heartbeat / error
detection / batch reassembly, retry engine with empty-stream switching,
model routing/mappings, quota queries, and ZCode desktop credential import.

## Quick Start

```bash
# Install dependencies
bun install

# Start the proxy — first run auto-creates config.yaml from the bundled
# template if it doesn't already exist (no need to cp from config.example.yaml).
# The template defaults to oauth mode + zai provider: the server starts,
# then you log in from the dashboard or via the CLI.
bun run src/index.ts

# Log in (opens the browser) — coding plan on Z.AI:
bun run src/index.ts auth login zai --plan=coding-plan
# ...or on Bigmodel, and/or --plan=start-plan for the free tier.

# Or specify a config path
bun run src/index.ts /path/to/config.yaml
```

Prefer an API key instead of OAuth? Set `auth.mode: apikey` and
`auth.apiKey` in `config.yaml` (see the comments in `config.example.yaml`).
`proxyApiKey` (the key your own clients must present) is optional and may
now be any length — leaving it empty disables client auth entirely
(loopback-only admin mode).


## Deploy to Render

This repo ships with a `Dockerfile`, `render.yaml` Blueprint, and
`render-start.sh` entrypoint — push to a Git repo, connect it to Render,
and you're done. The proxy supports both `apikey` and `oauth` auth modes
on Render (browser-based OAuth login happens on your laptop, then the
credential is exported and injected as an env var). All secrets come from
environment variables.

### Option A: One-click Blueprint (recommended)

1. Fork this repo to your GitHub/GitLab account.
2. On Render, go to **Dashboard → New → Blueprint**, pick your fork.
3. Render auto-detects `render.yaml` and creates one web service.
4. In the service's **Environment** tab, configure auth (see below).
5. Render deploys automatically. The proxy is live at
   `https://<service-name>.onrender.com`.

#### Authentication — pick ONE of two upstream modes

The proxy needs to authenticate against Z.AI / Bigmodel upstream. You have
two ways to do this. **Pick ONE**, not both.

**Mode A — apikey (simpler, recommended for most users):**

Set these env vars in Render:
- `ZCODE_API_KEY` — upstream credential.
  - Z.AI: `<apiKey>.<secretKey>` (both halves, dot-separated).
  - Bigmodel: `<apiKey>`.
- Leave `ZCODE_AUTH_MODE` at its default (`apikey`).
- Leave `ZCODE_OAUTH_CREDENTIAL` unset.

**Mode B — oauth (reuse a credential from your local ZCode / `zcode-proxy auth login`):**

Use this if you already logged into ZCode desktop, or if you ran
`zcode-proxy auth login zai` locally and want to reuse that credential
on Render without dealing with raw API keys.

Steps:
1. On your laptop (where you have a browser):
   ```bash
   git clone https://github.com/<your-username>/lealll.git
   cd lealll
   bun install
   bun run src/index.ts auth login zai    # or bigmodel
   # ↑ browser opens, you authorize, credential is saved locally
   bun run src/index.ts auth export
   # ↑ prints a base64 blob
   ```
2. Copy the base64 blob (between the `===` markers).
3. On Render, set:
   - `ZCODE_AUTH_MODE=oauth`
   - `ZCODE_OAUTH_CREDENTIAL=<paste blob here>`
4. Leave `ZCODE_API_KEY` unset.

**Regardless of mode, you MUST also set:**
- `ZCODE_PROXY_API_KEY` — the secret YOUR clients will pass as
  `Authorization: Bearer <key>`. Pick any strong random string (32+ chars).
  If unset, anyone who can reach your Render URL can burn your quota.

**Optional (any mode):**
- `ZCODE_PROVIDER` — `zai` (default) or `bigmodel`.
- `ZCODE_PROXY_LEGACY_SEED` — only for one-time recovery of credential stores
  written by older versions that used env/homedir-derived keys.
- `ZCODE_PROXY_CORS_ALLOWLIST` — comma-separated allowed browser origins.
- `ZCODE_RETRY_MAX`, `ZCODE_RETRY_STATUSES` — retry tuning.

### Option B: Manual web service

1. **New → Web Service → Connect your repo.**
2. **Runtime**: Docker (Render detects `Dockerfile` automatically).
3. **Plan**: Free (sleeps after 15 min inactivity) or Starter ($7/mo, always-on).
4. **Environment variables**: same as Option A step 4.
5. **Health Check Path**: `/healthz` (already configured in `render.yaml`).
6. Click **Create Web Service**.

### Using the deployed proxy

```bash
# Replace <service> with your Render URL and <proxy-key> with ZCODE_PROXY_API_KEY
curl https://<service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <proxy-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Hello from Render!"}],
    "stream": false
  }'

# Codex CLI / OpenAI SDK
export OPENAI_API_KEY="<proxy-key>"
export OPENAI_BASE_URL="https://<service>.onrender.com/v1"
codex --model glm-4.6
```

### Render-specific behavior

| Concern | Behavior |
|---------|----------|
| **Port** | `render-start.sh` maps Render's `$PORT` → `ZCODE_PROXY_PORT`. |
| **Filesystem** | Free tier is read-only except `/tmp`. `render-start.sh` auto-detects writability and falls back to `/tmp/zcode-proxy` if `/data` isn't writable. On paid tier with a persistent disk mounted at `/data`, OAuth credentials survive restarts. |
| **Config file** | Auto-seeded from `config.example.yaml` (with placeholder API key stripped) into `$ZCODE_PROXY_CONFIG`. Real secrets come from env vars, which override YAML. |
| **Health check** | `/healthz`, `/health`, and `/` are exempt from `proxyApiKey` so Render's probes succeed without auth headers. |
| **OAuth login** | Browser login is not supported on Render. Generate/export OAuth credentials locally, then inject `ZCODE_OAUTH_CREDENTIAL`, or use `auth.mode: apikey` + `ZCODE_API_KEY`. |
| **Start-plan captcha** | The Docker image includes Chromium + Xvfb. Render starts a virtual display so ZCode-aligned start-plan preflight and 3007 retries can use the Chrome CDP path instead of the weaker JSDOM fallback. |
| **Auto-deploy** | Enabled by default in `render.yaml`. Push to `main` → Render rebuilds. |
| **Sleep behavior** | Free tier sleeps after 15 min of inactivity. First request after sleep takes ~30s. Use Starter plan for always-on. |

### Optional: persistent disk (paid tier only)

Uncomment the `disk:` block in `render.yaml` to attach a 1GB persistent disk
at `/data`. This lets the dashboard's multi-account UI and any OAuth-imported
credentials survive restarts and deploys.

### Local Docker test

```bash
docker build -t zcode-proxy .
docker run --rm -p 8080:8080 \
  -e ZCODE_API_KEY="yourApiKey.yourSecretKey" \
  -e ZCODE_PROXY_API_KEY="your-proxy-secret" \
  zcode-proxy
# Proxy is live at http://localhost:8080
```

### Full environment variable reference

#### Required ALWAYS (regardless of auth mode)

| Variable | Example | Description |
|----------|---------|-------------|
| `ZCODE_PROXY_API_KEY` | `sk-proxy-7f3e9b...` | The secret YOUR clients must pass as `Authorization: Bearer <key>` (OpenAI format) or `x-api-key: <key>` (Anthropic format). Pick any strong random string (32+ chars recommended). If unset, anyone who can reach your Render URL can burn your quota. |

#### Upstream auth — pick Mode A OR Mode B (not both)

**Mode A: apikey (simpler)**

| Variable | Example | Description |
|----------|---------|-------------|
| `ZCODE_API_KEY` | `abc123.xyz789` (Z.AI) or `abc123` (Bigmodel) | Upstream credential. For Z.AI, must be `apiKey.secretKey` (both halves, dot-separated). For Bigmodel, just `apiKey`. Get it from your provider's dashboard. |

**Mode B: oauth (reuse local login)**

| Variable | Example | Description |
|----------|---------|-------------|
| `ZCODE_AUTH_MODE` | `oauth` | Must be set to `oauth` to activate Mode B. Default is `apikey`. |
| `ZCODE_OAUTH_CREDENTIAL` | `eyJhcGlLZXk...` (base64 blob) | Base64-encoded JSON Credential. Generate locally with `zcode-proxy auth login <provider>` then `zcode-proxy auth export`. Contains the upstream credential in plaintext — treat as a secret. |

#### Provider selection

| Variable | Default | Allowed | Description |
|----------|---------|---------|-------------|
| `ZCODE_PROVIDER` | `zai` | `zai` \| `bigmodel` | Which upstream to use. Must match the credential format. In Mode B, the credential's `provider` field takes precedence; this var is only used for routing in apikey mode. |

#### Identity spoofing (optional — only change if you know what you're doing)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZCODE_APP_VERSION` | `3.2.5` | `User-Agent: ZCode/{version}` sent to upstream. The start-plan captcha config request also sends this as `app_version`, matching the official client. Must be printable ASCII. |
| `ZCODE_SOURCE_TITLE` | `Z Code@electron` | `X-Title` sent to upstream. |
| `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL sent to upstream. |
| `ZCODE_AGENT` | `glm` | `X-ZCode-Agent` sent on upstream model requests to mirror the official GLM agent provider. |
| `ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT` | enabled | Start-plan pre-solves and sends fresh Aliyun captcha runtime headers before each model attempt, matching ZCode. Set to `0`, `false`, `off`, `no`, or `never` to solve only after an explicit `3007` challenge. |
| `ZCODE_STARTPLAN_UPSTREAM` | `anthropic` | v0.3.7: start-plan upstream wire style. `anthropic` (default) routes through the zcode.z.ai Anthropic mirror (`/api/v1/zcode-plan/anthropic/v1/messages`); `openai` restores the legacy v0.3.0 gateway pipeline (`/api/v1/zcode-plan/chat/completions` — removed server-side 2026-08-27, currently 404). |
| `ZCODE_CAPTCHA_SOLVER` | `auto` | Captcha solver strategy: `auto` prefers a real Chrome/Edge CDP page (matching ZCode's Electron renderer) and falls back to JSDOM, `chrome` forces Chrome/Edge, `jsdom` forces the single-binary fallback. |
| `ZCODE_CAPTCHA_LANGUAGE` | host locale | Optional Aliyun SDK language override: `cn` or `en`. When unset, Chinese host locales use `cn`; all others use `en`, matching the official client's locale behavior. |
| `ZCODE_CAPTCHA_CHROME_INTERACTIVE` | `0` | Set to `1` to show the Chrome captcha fallback window on screen when Aliyun escalates from traceless verification to an interactive challenge. |
| `ZCODE_CAPTCHA_CHROME_URL` | temporary `127.0.0.1` page | Optional captcha host page for the Chrome solver. Leave unset unless debugging; the proxy starts a local no-CSP page automatically. |
| `ZCODE_CAPTCHA_CHROME_USER_DATA_DIR` | `~/.zcode-proxy/captcha-chrome-profile` | Persistent Chrome/Edge profile used by the start-plan captcha solver, so the browser/device state is stable like ZCode's Electron renderer. |
| `ZCODE_CAPTCHA_CHROME_KEEPALIVE` | `1` | Keep one hidden Chrome CDP helper alive and reuse it across start-plan captcha solves. Set to `0`, `false`, `off`, or `never` to restore the old launch-per-solve behavior. |
| `ZCODE_CAPTCHA_CHROME_IDLE_MS` | `600000` | Idle timeout before the persistent Chrome helper is closed. Set to `0` to keep it alive until process exit or manual stop from the dashboard. |
| `ZCODE_CAPTCHA_CHROME_STOP_GRACE_MS` | `2000` | Max time to wait for an active Chrome captcha solve when the dashboard stops the helper. Set to `0` to tear it down immediately. |
| `ZCODE_CAPTCHA_CHROME_EPHEMERAL` | `0` | Set to `1` to use one temporary Chrome profile per captcha solve. This is less ZCode-like and may trigger more checks. |

#### Retry policy (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZCODE_RETRY_MAX` | `3` | Max retry attempts per request. Set to `0` to disable retries. |
| `ZCODE_RETRY_INITIAL_DELAY_MS` | `1000` | Wait before first retry (ms). |
| `ZCODE_RETRY_MAX_DELAY_MS` | `8000` | Cap on backoff delay (ms). |
| `ZCODE_RETRY_BACKOFF_FACTOR` | `2` | Multiplier per attempt (exponential). |
| `ZCODE_RETRY_STATUSES` | `529` | Comma-separated upstream HTTP statuses that trigger retry. Example: `529,429,503`. |
| `ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD` | `5` | Consecutive failures before auto-switching to a different stored credential. Only effective with multi-account setup. |

#### Security / CORS (recommended for production)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZCODE_PROXY_LEGACY_SEED` | unset | One-time recovery seed for credentials encrypted by older versions that used env/homedir-derived keys. Current credential stores use the fixed `SHA-256("520")` key; do not set the old `ZCODE_PROXY_CREDENTIAL_SECRET` for normal use. |
| `ZCODE_PROXY_CORS_ALLOWLIST` | unset (browser denied) | Comma-separated allowed origins for browser CORS. Example: `https://your-dashboard.example.com,http://localhost:3000`. When unset, server-to-server requests without an `Origin` header still get `*`, but browser requests with an `Origin` header receive `Access-Control-Allow-Origin: null`. |
| `ZCODE_PROXY_MAX_REQUEST_BODY_BYTES` | `67108864` | Max client request body size in bytes. Set `0` to disable. |
| `ZCODE_PROXY_POOL_MAX_SOURCE_BYTES` | `10485760` | Max remote proxy-list download size in bytes. Set `0` to disable. |
| `ZCODE_PROXY_POOL_SOURCE_CONCURRENCY` | `5` | Max proxy-list source URLs fetched concurrently during pool refresh. |
| `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE` | unset | Auto-set to `1` by `render-start.sh` in Mode B. Don't set manually. |

#### Render-specific (auto-set by `render-start.sh`, don't override unless debugging)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | set by Render | Render injects this. `render-start.sh` maps it to `ZCODE_PROXY_PORT`. |
| `ZCODE_PROXY_PORT` | `$PORT` or `8080` | Port the proxy listens on. Don't set this manually on Render. |
| `ZCODE_PROXY_CONFIG` | `/data/config.yaml` or `/tmp/zcode-proxy/config.yaml` | Path to config file. Auto-seeded on first run. |
| `ZCODE_PROXY_STORE_DIR` | `/data/.zcode-proxy` or `/tmp/zcode-proxy/.zcode-proxy` | Directory for encrypted credential store. Auto-detected based on `/data` writability. |

### Detailed deployment walkthrough

#### 1. Prepare your credentials

Pick ONE of two paths:

**Path A — apikey mode (no local setup needed):**

1. Get your upstream API key:
   - **Z.AI**: Log in at https://z.ai → API Keys → create a key. You'll get an `apiKey` and a `secretKey`. Combine as `apiKey.secretKey`.
   - **Bigmodel**: Log in at https://bigmodel.cn → API Keys → create. You get a single `apiKey`.
2. Generate a strong random string for `ZCODE_PROXY_API_KEY` (your client-facing secret):
   ```bash
   openssl rand -hex 32
   ```
3. Skip to step 2.

**Path B — oauth mode (reuse local login):**

1. On your laptop, clone and install:
   ```bash
   git clone https://github.com/<your-username>/lealll.git
   cd lealll && bun install
   ```
2. Login via OAuth (browser opens):
   ```bash
   bun run src/index.ts auth login zai       # or: bigmodel
   # For ZCode desktop users, you can also import instead:
   bun run src/index.ts auth login zai --import
   ```
3. Export the credential as a base64 blob:
   ```bash
   bun run src/index.ts auth export
   # Output:
   # === ZCODE_OAUTH_CREDENTIAL (base64) ===
   # eyJhcGlLZXkiOiJhYmMxMjM...
   # === END ===
   ```
4. Copy the base64 blob (between the `===` markers, not including them).
5. Generate a strong random string for `ZCODE_PROXY_API_KEY`:
   ```bash
   openssl rand -hex 32
   ```
6. Continue to step 2.

#### 2. Push the code to a Git repo Render can see

```bash
# Fork on GitHub first, then:
git clone https://github.com/<your-username>/lealll.git
cd lealll
# (any customizations you want)
git push origin main
```

#### 3. Create the Render service

1. Go to https://dashboard.render.com.
2. Click **New +** → **Blueprint**.
3. Select your repo (the one you forked to).
4. Render detects `render.yaml` and shows a preview of the service it'll create.
5. Click **Apply**.
6. Render pulls the repo, builds the Docker image, and starts the container.
   First build takes ~2-3 minutes.

#### 4. Configure environment variables

In Render dashboard, click your new service → **Environment** tab.

**Always set (regardless of path):**

| Key | Value |
|-----|-------|
| `ZCODE_PROXY_API_KEY` | `<the random string from step 1>` |

**If you chose Path A (apikey):**

| Key | Value |
|-----|-------|
| `ZCODE_API_KEY` | `<your upstream key>` (Z.AI: `apiKey.secretKey`, Bigmodel: `apiKey`) |
| `ZCODE_PROVIDER` | `zai` or `bigmodel` (must match the key format) |

**If you chose Path B (oauth):**

| Key | Value |
|-----|-------|
| `ZCODE_AUTH_MODE` | `oauth` |
| `ZCODE_OAUTH_CREDENTIAL` | `<the base64 blob from step 1>` |

**Optional (any path):**

| Key | Value |
|-----|-------|
| `ZCODE_PROXY_LEGACY_SEED` | only if recovering an old credential store |
| `ZCODE_PROXY_CORS_ALLOWLIST` | e.g. `https://chat.example.com` (browser CORS allowlist) |
| `ZCODE_RETRY_MAX` | `5` |
| `ZCODE_RETRY_STATUSES` | `529,429,503` |

Click **Save Changes**. Render triggers a new deploy automatically.

#### 5. Verify the deployment

After the deploy finishes (watch the **Events** tab — it'll say "Live"):

```bash
# 1. Health check (should return 200 with no auth)
curl https://<service-name>.onrender.com/healthz
# Expected: {"status":"ok","provider":"zai"}

# 2. Models list (should 401 without auth)
curl -i https://<service-name>.onrender.com/v1/models

# 3. Models list with auth (should return JSON model list)
curl https://<service-name>.onrender.com/v1/models \
  -H "Authorization: Bearer <your-proxy-secret>"
# Expected: {"object":"list","data":[{"id":"glm-4.6",...},...]}

# 4. Real chat completion (uses your upstream quota)
curl https://<service-name>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <your-proxy-secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Say hello in 5 words"}],
    "stream": false
  }'
```

If step 4 returns a 200 with a real completion, your deployment is fully working.

**Path A troubleshooting:**
- 401 from upstream → `ZCODE_API_KEY` wrong format. Z.AI needs `apiKey.secretKey` (with the dot).
- 401 from proxy → your client isn't sending `Authorization: Bearer <ZCODE_PROXY_API_KEY>`.

**Path B troubleshooting:**
- "Failed to decrypt credential store" → `ZCODE_OAUTH_CREDENTIAL` is corrupted or not valid base64. Re-run `zcode-proxy auth export` and re-copy.
- "Not logged in for OAuth mode" → `ZCODE_AUTH_MODE` is `oauth` but `ZCODE_OAUTH_CREDENTIAL` is empty. Check for trailing whitespace when pasting.
- Credential expired → OAuth tokens have `expiresAt`. If your credential is old, re-login locally and re-export.

#### 6. Wire up your clients

**OpenAI Python SDK:**
```python
from openai import OpenAI
client = OpenAI(
    api_key="<your-proxy-secret>",
    base_url="https://<service-name>.onrender.com/v1",
)
resp = client.chat.completions.create(
    model="glm-4.6",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

**Anthropic SDK:**
```python
from anthropic import Anthropic
client = Anthropic(
    api_key="<your-proxy-secret>",
    base_url="https://<service-name>.onrender.com",
)
resp = client.messages.create(
    model="glm-4.6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.content[0].text)
```

**Codex CLI:**
```bash
export OPENAI_API_KEY="<your-proxy-secret>"
export OPENAI_BASE_URL="https://<service-name>.onrender.com/v1"
codex --model glm-4.6
```

**curl (Anthropic format):**
```bash
curl https://<service-name>.onrender.com/v1/messages \
  -H "x-api-key: <your-proxy-secret>" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### 7. (Optional) Persistent disk on paid tier

If you want the dashboard's multi-account UI to persist across restarts,
and you're on the **Starter** plan ($7/mo) or higher:

1. Edit `render.yaml`, uncomment the `disk:` block.
2. Push to `main` — Render redeploys with a 1GB disk at `/data`.
3. Future deploys preserve `/data/.zcode-proxy/credentials.json`.

Note: In Path B (oauth), the credential is re-injected from the env var on
every restart, so a persistent disk isn't strictly needed. The disk is only
useful if you add more accounts via the dashboard UI after deploy.

#### 8. Monitor and troubleshoot

- **Live logs**: Render dashboard → service → **Logs** tab. Streams `console.log`/`console.error` from the proxy.
- **Dashboard UI**: `https://<service-name>.onrender.com/admin` (open; API routes need `Authorization: Bearer <proxy-secret>`). Shows live request stats, model breakdown, config editor, account manager.
- **Health**: Render pings `/healthz` every ~30s. If 3 consecutive checks fail, Render restarts the container. You can see check results in the **Events** tab.
- **Common issues**:
  - **`401 from upstream`** (Path A) → `ZCODE_API_KEY` is wrong format. Z.AI needs `apiKey.secretKey` (with the dot).
  - **`401 from upstream`** (Path B) → OAuth credential expired. Re-login locally and re-export.
  - **`401 from proxy`** → your client isn't sending `Authorization: Bearer <ZCODE_PROXY_API_KEY>`.
  - **`502 upstream_unreachable`** → upstream (Z.AI / Bigmodel) is down or rate-limiting you. Check `ZCODE_RETRY_STATUSES` includes the status you're seeing.
  - **`Failed to decrypt credential store`** (Path B) → `ZCODE_OAUTH_CREDENTIAL` is corrupted. Re-export and re-paste.
  - **Render says "Deploy failed"** → check the build logs. Most common cause: `bun install` network timeout (redeploy usually fixes it).
  - **Container restarts in a loop** → `/healthz` returning non-200. Check the Logs tab for the actual error.

## Authentication

### Option 1: Direct API Key (simplest)

1. Get an API key from [Z.AI](https://z.ai) or [Bigmodel](https://bigmodel.cn)
2. For Z.AI you need `{apiKey}.{secretKey}` format
3. For Bigmodel you need `{apiKey}` format
4. Set it in `config.yaml`:

```yaml
auth:
  mode: apikey
  apiKey: "yourApiKey.yourSecretKey"
provider: zai  # or bigmodel
```

### Option 2: OAuth Login (browser-based, both providers)

```bash
# Z.AI device/poll flow (coding-plan is the default; use --plan=start-plan for start-plan)
bun run src/index.ts auth login zai [--plan=coding-plan|start-plan]

# Bigmodel auth-code flow (via zcode.z.ai proxy)
bun run src/index.ts auth login bigmodel [--plan=coding-plan|start-plan]

# This will:
# 1. Print an authorize URL and open your browser
# 2. Exchange the auth code for upstream credentials
# 3. Resolve your coding-plan API key automatically
# 4. Save encrypted credentials to ~/.zcode-proxy/credentials.json

# Then set config.yaml:
auth:
  mode: oauth
provider: zai  # or bigmodel
```

### Option 3: Import from ZCode Config (skip OAuth)

If you already use the ZCode desktop app, import the API key directly:

```bash
bun run src/index.ts auth login bigmodel --import
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming + non-streaming) |
| `POST` | `/v1/messages` | Anthropic-format messages (streaming + non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (streaming + non-streaming, Codex CLI compatible) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check (also served at `/`) |
| `GET` | `/admin` | Admin dashboard (web UI: stats, logs, config, accounts, OAuth login) |
| `*`   | `/admin/api/*` | Admin API endpoints used by the dashboard |

## Admin Dashboard

Open `http://localhost:8080/admin` in your browser. The dashboard lets you:

- View live request stats (counts, latency, tokens/s, model breakdown)
- Stream live logs (filter by level / search)
- Edit config (provider, plan, models, identity, retry, routing rules, model mappings)
- Manage stored accounts (multi-account: add, switch active, edit label/plan, export/import)
- Trigger OAuth login for Z.AI or Bigmodel
- Inspect upstream 4xx debug dumps (transformed request bodies that triggered errors)

The dashboard uses the same `auth.proxyApiKey` as the API endpoints (pass it as
`Authorization: Bearer <key>`). When `proxyApiKey` is unset the dashboard is
**open to anyone with network access** — set the key in production.

## Usage Examples

### OpenAI Format

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Anthropic Format

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

### OpenAI Responses API (Codex CLI)

```bash
curl http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello!"}]}],
    "stream": false
  }'
```

Codex CLI integration — set these env vars before launching `codex`:

```bash
export OPENAI_API_KEY="your-proxy-secret"
export OPENAI_BASE_URL="http://localhost:8080/v1"
# Instruct Codex CLI to use the Responses wire format
# (already default in recent versions; older versions may need this)
codex --model glm-4.6
```

The proxy translates `POST /v1/responses` to Anthropic Messages upstream and back,
emitting the full Responses streaming event sequence (`response.created` →
`response.output_text.delta` → `response.completed`) that Codex CLI expects.
`previous_response_id` is supported via an in-memory LRU store (256 turns,
each capped at 256 KB of serialized input+output to bound memory).

### List Models

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-proxy-secret"
```

## Configuration

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `server.port` | `ZCODE_PROXY_PORT` | `8080` | Listen port |
| `auth.apiKey` | `ZCODE_API_KEY` | — | Upstream API key |
| `auth.proxyApiKey` | `ZCODE_PROXY_API_KEY` | — | Client auth key |
| `provider` | `ZCODE_PROVIDER` | `zai` | Upstream provider |
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.2.5` | `User-Agent: ZCode/{version}` |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `Z Code@electron` | `X-Title` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |
| `identity.deviceMid` | `ZCODE_DEVICE_MID` | auto-read from ZCode telemetry | Optional `X-Device-Mid` |
| `identity.zcodeAgent` | `ZCODE_AGENT` | `glm` | `X-ZCode-Agent` for model requests |
| `server.maxRequestBodyBytes` | `ZCODE_PROXY_MAX_REQUEST_BODY_BYTES` | `67108864` | Max client request body size in bytes; set `0` to disable. |
| — | `ZCODE_PROXY_LEGACY_SEED` | unset | Manual one-time recovery seed for credentials.json encrypted by an older version. See Security Notes. `ZCODE_PROXY_CREDENTIAL_SECRET` is intentionally NOT consulted — it was the #1 cause of credential loss on restart. |
| — | `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE` | unset | Set to `1` to allow loading a plaintext credentials.json (debug/test only) |
| — | `ZCODE_PROXY_CORS_ALLOWLIST` | unset | Comma-separated allowed origins for `Access-Control-Allow-Origin`. When unset, browser requests with an `Origin` header get `null`; server-to-server requests without `Origin` get `*`. When set, only listed origins get `Access-Control-Allow-Origin: <origin>`; all others get `null`. |
| — | `ZCODE_PROXY_POOL_SOURCE_CONCURRENCY` | `5` | Max proxy-list source URLs fetched concurrently during pool refresh. |
| — | `ZCODE_PROXY_CONFIG` | `config.yaml` | Path to the config file (used when `serve` is called with no positional arg) |

## Security Notes

- **`auth.proxyApiKey`**: if unset, anyone with network access to the port can use your upstream credentials. The proxy prints a warning at startup if this is missing.
- **Credential store encryption**: `~/.zcode-proxy/credentials.json` is AES-256-GCM encrypted with a FIXED key derived from `SHA-256("520")`. The same key is used on every machine, every OS, every run — so credentials.json is portable across devices and never breaks due to key drift. There is NO env-var override, NO key file in the credential directory, NO seed derivation — just one constant key, everywhere, always. This eliminates the entire class of "key drift" bugs (homedir resolving differently across Bun versions, USERPROFILE vs HOMEDRIVE+HOMEPATH on Windows, username changes, OS reinstalls, copying credentials.json between machines, and the old `ZCODE_PROXY_CREDENTIAL_SECRET` env var being set during one run and not the next) that previously caused "重启突然凭证全部丢失".
- **Atomic writes + mutex**: credentials.json is written via `atomicWriteFile` (write-to-tmp + rename) so a crash mid-write leaves the previous file intact instead of a truncated/partial one. All mutations are serialized via an in-process mutex so concurrent dashboard writes + proxy auto-switch calls don't race (last-writer-wins would silently drop accounts).
- **Manual recovery (one-time)**: if your credentials.json was encrypted by an older version that used seed-based or env-var-derived key derivation, set `ZCODE_PROXY_LEGACY_SEED` to the old seed string (e.g. `C:\\Users\\OldName-win32-x64` or the old `ZCODE_PROXY_CREDENTIAL_SECRET` value) and the file will be recovered on next read, then re-encrypted with the fixed 520 key on the next write — so this is a one-time migration, not a permanent dependency on the old key. `ZCODE_PROXY_CREDENTIAL_SECRET` itself is intentionally NOT consulted anymore.
- **Plaintext loading backdoor**: gated behind `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` to prevent bypass-via-file-write attacks.
- **CORS**: by default browser requests with an `Origin` header are denied (`Access-Control-Allow-Origin: null`). For browser frontends, set `ZCODE_PROXY_CORS_ALLOWLIST` to the comma-separated list of origins you trust (e.g. `http://localhost:3000,https://your-dashboard.example.com`).
- **Upstream timeouts**: stream requests time out after 10 minutes; batch requests after 5 minutes. A hung upstream connection no longer pins a Bun worker forever — it surfaces as `502 upstream_unreachable`.

## Architecture

```
Client Request
      │
      ▼
Proxy API Key Auth (shared secret)
      │
      ▼
Route Detection + Plan-aware Routing
  /v1/chat/completions (OpenAI client format)
    ├─ coding-plan → TRANSLATE to Anthropic → provider's anthropic endpoint
    └─ start-plan  → TRANSLATE to Anthropic → zcode.z.ai gateway (JWT + captcha)
  /v1/messages     (Anthropic client format)
    ├─ coding-plan → passthrough to provider's anthropic endpoint
    └─ start-plan  → passthrough to zcode.z.ai gateway (JWT + captcha)
      │
      ▼
Body Transformation (ZCode-equivalent mutations)
  OpenAI streaming    → inject stream_options.include_usage
  Anthropic           → add cache_control to last user message
  Anthropic + OAuth   → inject metadata.user_id
      │
      ▼
[Translation mode only] OpenAI request → Anthropic request body
      │
      ▼
Auth + Identity Header Injection
  Translation/coding-plan:  x-api-key: {credential} + anthropic-version
  Translation/start-plan:   Authorization: Bearer {jwt} + anthropic-version
  Passthrough/start-plan:   Authorization: Bearer {jwt} + anthropic-version
  Passthrough/coding-plan:  x-api-key: {credential} + anthropic-version
  Both:                     User-Agent: ZCode/{version} + X-ZCode-* + trace headers
      │
      ▼
Upstream Forward (Bun.fetch)
  Translation mode:   decompress enabled (proxy reads + translates body)
  Passthrough:        decompress disabled (raw gzip bytes stream through)
      │
      ▼
Response Handling
  Passthrough:              raw bytes → client (content-encoding preserved)
  Translation batch:        Anthropic JSON → OpenAI JSON → gzip if client accepts
  Translation SSE stream:   Anthropic SSE → OpenAI SSE chunks → client
```

## Development

```bash
# Run tests
bun run test

# Run tests with full proxy request logs
ZCODE_PROXY_TEST_LOGS=1 bun run test

# Type check
bun run typecheck

# Run in dev mode
bun run src/index.ts config.yaml

# Build Windows executable
bun run build
```

## Available Models

The proxy lists these models on `GET /v1/models` (pinned to the GLM coding-plan tier):

| Model | Context | Max Output |
|-------|---------|------------|
| `glm-4.5-air` | 200K | 128K |
| `glm-4.6` | 200K | 128K |
| `glm-4.6v` | 200K | 128K |
| `glm-4.7` | 200K | 128K |
| `glm-5` | 200K | 128K |
| `glm-5-turbo` | 200K | 128K |
| `glm-5v-turbo` | 200K | 128K |
| `glm-5.1` | 200K | 128K |
| `glm-5.2` | 1M | 128K |
| `glm-5.3` | 1M | 128K |

Requests for models not in this list are still forwarded upstream — the listing is informational, not a gate.

## License

MIT
