# ZCode Proxy — Android Build

This document explains how to build the Android APK from source. The Android
app wraps the TypeScript proxy server (bundled as a Node.js CJS bundle) inside
a Kotlin shell; OAuth login happens in the system browser via Custom Tabs.

## Prerequisites

- **Bun** 1.4.0 (pinned — CI and release builds use exactly this version) —
  for building the TS bundle
- **JDK 17** (Temurin recommended)
- **Android SDK** with platform `android-35` and build-tools `35.0.0`
- **GNU binutils** (`ar`, `tar`, `xz`) on PATH — only needed if you re-extract
  the Termux Node.js `.deb` packages via `scripts/extract-termux-deps.sh` (the
  extracted `.so` files are committed in `app/src/main/jniLibs/arm64-v8a/`)

## 使用步骤

1. 安装 APK 后打开应用，首次启动会申请通知权限。通知可以返回应用或停止整个后台服务；拒绝通知权限时仍可在应用内操作。
2. 在主页选择服务商和套餐，点击登录，在系统浏览器完成授权后返回应用。等待授权期间会显示提示；授权未完成时可重新登录。
3. 点击「启动代理」。OpenAI 客户端复制 `http://127.0.0.1:8080/v1`，Anthropic 客户端使用 `http://127.0.0.1:8080`，实际端口以主页为准。
4. 「停止代理」保留本地控制服务和登录状态；通知中的「停止服务」会关闭整个后台服务。再次打开应用或点击恢复按钮可启动服务。
5. 启动失败时点击「查看诊断」复制最近的启动日志，再点击「启动服务」重试；服务已连接但没有响应时可点击「重启服务」。
6. 设置页可打开通知设置和高级管理面板。高级管理面板需先启动代理，提供账户、统计和详细配置。

## Build steps

```bash
bun install --frozen-lockfile
export ANDROID_HOME=/path/to/android-sdk
# Automatically rebuilds/copies server.cjs and invokes the Gradle wrapper.
bun run build:android-apk
# Run Android JVM tests, lint and packaging together:
bun run build:android-apk :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
# Exercise the actual Android Node entry with a local mock upstream:
python3 scripts/android-smoke.py
adb install -r Android-APP/app/build/outputs/apk/debug/app-debug.apk
```

The wrapper pins Gradle 8.9 with SHA256 verification, paired with AGP 8.7.3,
SDK 35 and build-tools 35.0.0. The helper prefers a local JDK/SDK;
`ANDROID_BUILD_MODE=local|docker` overrides selection. Docker mode uses
`llama-android-builder:latest` (build it with `scripts/android-builder.Dockerfile`)
and the same Gradle wrapper. Extra Gradle tasks and `-P` options are forwarded.
Node binaries are committed in `jniLibs`; Gradle and Maven dependencies may
be downloaded on the first build.

A debug APK is test-signed. Updating an existing installation requires a
matching signing certificate and an equal or greater `versionCode`; local
builds now derive the default code from the repository version just like CI,
with `-PandroidApp.versionCode=...` available for overrides. Use the
original release keystore for distributable updates. An unsigned release APK
cannot be installed directly.

## Release build (signed)

Release builds enable R8 code optimization and resource shrinking; debug
builds keep readable classes for debugging.

Requires GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The
release CI workflow (`.github/workflows/release.yml`, manual dispatch with a
`vX.Y.Z` tag input) builds a signed APK. For local signed builds:

```bash
cd Android-APP
./gradlew assembleRelease \
  -PandroidSigning.keystoreFile=/path/to/release.keystore \
  -PandroidSigning.storePassword=... \
  -PandroidSigning.keyAlias=... \
  -PandroidSigning.keyPassword=...
```

## Architecture

- `Android-APP/` — Gradle project; everything Android-specific lives here.
- `Android-APP/app/src/main/java/com/zcode/proxy/` — Kotlin shell.
- `Android-APP/app/src/main/assets/server_bundle/` — tracked sidecar assets
  (`config.example.yaml`, `webui.txt`, `zcode_system.json`); `server.cjs` is
  gitignored build output — the APK helper regenerates it automatically (Gradle's
  `checkServerBundle` preBuild task fails with a hint if it is missing).
- `Android-APP/app/src/main/jniLibs/arm64-v8a/` — committed Node.js binary
  (`libnode.so`) + Termux dependency `.so` files, extracted once via
  `scripts/extract-termux-deps.sh`.
- `Android-APP/gradle/node-binary.lock.json` — pinned URLs and SHA256s.

## OAuth flow

1. App taps "Login with {provider}" → `ControlClient.startOAuth(provider)`.
2. Node starts the OAuth flow and returns the authorize URL. **Both
   providers** use the server-mediated CLI poll flow (ZCode 3.12.3 parity):
   `/oauth/cli/init` + `/oauth/cli/poll/{flow_id}` at zcode.z.ai; the
   authorize URL carries the `/app/oauth/login` interstitial param. No
   localhost callback is involved.
3. App opens the URL with `CustomTabsIntent.launchUrl()` — the system browser
   handles login (OAuth providers block embedded WebViews).
4. User authenticates in the browser; after authorization the browser lands
   on the interstitial (which records the code server-side) and then tries to
   bounce to `zcode://`. That deep link only matters to the official desktop
   app — the browser's "cannot open link" notice is expected and can be
   ignored; the login has already completed server-side.
5. Node's background poll flips to `ready`, resolves the coding-plan API key
   and persists the encrypted credential; the app's 1.5s status polling
   reflects the logged-in state automatically.

## Validation and limitations

- **Start-plan tier untested on Android** — the in-process happy-dom captcha
  solver is bundled into `server.cjs` (jsdom was removed from the project
  entirely), but the tier has not been validated on-device. Coding-plan
  (direct upstream) remains the recommended tier; this refactor does not
  substitute for device testing of either OAuth provider.
- **Sideload distribution** — no Play Store submission is performed by this project.
  The `specialUse` foreground-service declaration describes a user-started local
  API proxy; a Play Store submission would require review of this use case.
- **arm64-v8a only** — no x86 / armeabi-v7a support. Requires a 64-bit ARM Android device (minimum API 24).
- **No iOS build** — Android only.

### Android module boundaries

| File/module | Responsibility |
| --- | --- |
| `MainActivity.kt` | Activity permissions, lifecycle and screen composition |
| `ui/ProxyViewModel.kt` | Retained state, polling, serialized UI commands and quota cancellation |
| `ui/HomeCards.kt`, `LogsScreen.kt`, `SettingsScreen.kt` | Page components |
| `ui/QuotaUi.kt`, `QuotaBlock.kt` | Quota normalization and rendering |
| `ui/Components.kt`, `RuntimeBanner.kt` | Reusable controls and recovery feedback |
| `ServerService.kt`, `RuntimeStatus.kt` | Foreground notification, process readiness and runtime state |
| `NodeRunner.kt`, `BundleExtractor.kt` | Native process and cached atomic asset extraction |
| `ControlClient.kt`, `ControlTransport.kt` | JSON commands and cancellable bounded HTTP transport |

Status/log polling stops when the Activity is hidden. ViewModel state survives
rotation. Quota requests are invalidated on login/provider/plan/session changes,
and late responses cannot restore obsolete data. Proxy uptime comes from the
server instead of restarting when the screen is reopened.

Runtime assets are extracted only after APK installation/update or a missing
asset, with atomic file replacement and a version marker committed last.
Configuration and credentials are kept separately from the extracted bundle.
The obsolete Android Keystore seed has been removed: the server already owns
credential persistence and did not use that seed. App backup is disabled so
runtime files and credentials are not copied into an unrelated installation.

## Permissions

- `INTERNET` — proxy server + upstream HTTPS
- `ACCESS_NETWORK_STATE` — detect connectivity changes
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` — keep Node.js alive
  when the app is backgrounded
- `POST_NOTIFICATIONS` — display the service notification on Android 13+
  (requested once; settings offers a recovery entry; denial does not block the service)

No permanent wake lock is acquired. OEM battery restrictions may still stop
background execution; allow background activity in system settings if needed.

Platform references: [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types),
[notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission),
[AGP 8.7 compatibility](https://developer.android.com/build/releases/agp-8-7-0-release-notes).
