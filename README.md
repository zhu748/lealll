# zcode-proxy

A reverse proxy for Z.AI / Bigmodel.cn coding-plan APIs that exposes both OpenAI-compatible and Anthropic-format endpoints.

## Quick Start

```bash
# Install dependencies
bun install

# Start the proxy — first run auto-creates config.yaml from the bundled
# template if it doesn't already exist (no need to cp from config.example.yaml)
bun run src/index.ts

# Or specify a config path
bun run src/index.ts /path/to/config.yaml
```

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
- `ZCODE_PROXY_CREDENTIAL_SECRET` — only needed if you use the dashboard's
  multi-account UI. Any random 32+ char string.
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
| **OAuth login** | Not supported on Render (no browser). Use `auth.mode: apikey` + `ZCODE_API_KEY` env var. |
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
| `ZCODE_APP_VERSION` | `3.1.1` | `User-Agent: ZCode/{version}` sent to upstream. Must be printable ASCII. |
| `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` sent to upstream. |
| `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL sent to upstream. |

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
| `ZCODE_PROXY_CREDENTIAL_SECRET` | derived from `homedir` | AES-256-GCM key for the credential store. On Render, set this to a random 32+ char string so the dashboard's multi-account UI works. **Not needed in Mode B** (plaintext store is used). |
| `ZCODE_PROXY_CORS_ALLOWLIST` | unset (permissive) | Comma-separated allowed origins for browser CORS. Example: `https://your-dashboard.example.com,http://localhost:3000`. When unset, any origin is echoed (legacy behavior — fine for server-to-server, risky if you expose the dashboard publicly). |
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
| `ZCODE_PROXY_CREDENTIAL_SECRET` | random 32+ char string (only needed for dashboard multi-account UI) |
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
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.1.1` | `User-Agent: ZCode/{version}` |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |
| — | `ZCODE_PROXY_LEGACY_SEED` | unset | Manual one-time recovery seed for credentials.json encrypted by an older version. See Security Notes. `ZCODE_PROXY_CREDENTIAL_SECRET` is intentionally NOT consulted — it was the #1 cause of credential loss on restart. |
| — | `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE` | unset | Set to `1` to allow loading a plaintext credentials.json (debug/test only) |
| — | `ZCODE_PROXY_CORS_ALLOWLIST` | unset | Comma-separated allowed origins for `Access-Control-Allow-Origin`. When unset, any origin is echoed (legacy permissive behavior). When set, only listed origins get `Access-Control-Allow-Origin: <origin>`; all others get `null`. |
| — | `ZCODE_PROXY_CONFIG` | `config.yaml` | Path to the config file (used when `serve` is called with no positional arg) |

## Security Notes

- **`auth.proxyApiKey`**: if unset, anyone with network access to the port can use your upstream credentials. The proxy prints a warning at startup if this is missing.
- **Credential store encryption**: `~/.zcode-proxy/credentials.json` is AES-256-GCM encrypted with a FIXED key derived from `SHA-256("520")`. The same key is used on every machine, every OS, every run — so credentials.json is portable across devices and never breaks due to key drift. There is NO env-var override, NO key file in the credential directory, NO seed derivation — just one constant key, everywhere, always. This eliminates the entire class of "key drift" bugs (homedir resolving differently across Bun versions, USERPROFILE vs HOMEDRIVE+HOMEPATH on Windows, username changes, OS reinstalls, copying credentials.json between machines, and the old `ZCODE_PROXY_CREDENTIAL_SECRET` env var being set during one run and not the next) that previously caused "重启突然凭证全部丢失".
- **Atomic writes + mutex**: credentials.json is written via `atomicWriteFile` (write-to-tmp + rename) so a crash mid-write leaves the previous file intact instead of a truncated/partial one. All mutations are serialized via an in-process mutex so concurrent dashboard writes + proxy auto-switch calls don't race (last-writer-wins would silently drop accounts).
- **Manual recovery (one-time)**: if your credentials.json was encrypted by an older version that used seed-based or env-var-derived key derivation, set `ZCODE_PROXY_LEGACY_SEED` to the old seed string (e.g. `C:\\Users\\OldName-win32-x64` or the old `ZCODE_PROXY_CREDENTIAL_SECRET` value) and the file will be recovered on next read, then re-encrypted with the fixed 520 key on the next write — so this is a one-time migration, not a permanent dependency on the old key. `ZCODE_PROXY_CREDENTIAL_SECRET` itself is intentionally NOT consulted anymore.
- **Plaintext loading backdoor**: gated behind `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` to prevent bypass-via-file-write attacks.
- **CORS**: by default the proxy echoes the requesting Origin. For production, set `ZCODE_PROXY_CORS_ALLOWLIST` to the comma-separated list of origins you trust (e.g. `http://localhost:3000,https://your-dashboard.example.com`).
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
bun test

# Type check
bun x tsc --noEmit

# Run in dev mode
bun run src/index.ts config.yaml
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

Requests for models not in this list are still forwarded upstream — the listing is informational, not a gate.

## License

MIT
