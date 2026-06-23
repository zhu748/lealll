# zcode-proxy 使用说明

> **v2.1.4.1test2 — Render 云部署支持 + dashboard 一键导出环境变量**
>
> 新增 Render / Fly.io / K8s 等云平台一键部署能力，dashboard 增加导出环境变量格式的凭证。
>
> **v2.1.4.1test2 关键改进**：
> 1. **Render Blueprint 一键部署**：新增 `render.yaml` Blueprint 配置文件，连接 GitHub 仓库即可一键部署到 Render，无需手动配置 Docker
> 2. **Dockerfile 支持**：基于 `oven/bun:1.1-debian` 镜像，内置 `/healthz` 健康检查，适配 Render / Fly.io / Cloud Run / K8s 等所有支持 Docker 的云平台
> 3. **render-start.sh 智能启动脚本**：自动映射 Render 的 `$PORT` → `ZCODE_PROXY_PORT`；自动探测 `/data` 可写性，不可写时降级到 `/tmp/zcode-proxy`；自动从 `config.example.yaml` 种子化 `config.yaml`
> 4. **`/healthz` 健康检查端点**：新增 K8s 约定的 `/healthz` 路径（同时保留 `/health` 和 `/`），且 `/healthz`、`/health`、`/` 三个端点免 `proxyApiKey` 认证，确保 Render 探针无需 Authorization 头即可通过
> 5. **`ZCODE_AUTH_MODE` 环境变量**：支持通过环境变量覆盖 `auth.mode` 配置，Render 用户无需编辑 yaml 即可在 apikey 和 oauth 模式间切换
> 6. **`ZCODE_OAUTH_CREDENTIAL` 环境变量**：OAuth 模式下，支持通过 base64 编码的 JSON 凭证注入。本地用 `zcode-proxy auth export` 导出后粘贴到 Render 环境变量，无需在云端重复 OAuth 流程
> 7. **`auth export` CLI 子命令**：本地登录后执行 `zcode-proxy auth export`，输出可直接填入 `ZCODE_OAUTH_CREDENTIAL` 的 base64 blob
> 8. **dashboard "导出 Render 凭证" 按钮**：在 dashboard 账号管理页面新增按钮，点击后弹窗展示 `ZCODE_AUTH_MODE` 和 `ZCODE_OAUTH_CREDENTIAL` 两个环境变量值，附带一键复制按钮和详细操作说明
> 9. **`/admin/api/accounts/render-export` 接口**：dashboard 后端接口，返回当前激活凭证的 base64 编码 + 环境变量格式 + 操作指引
> 10. **凭证存储路径可配置**：`ZCODE_PROXY_STORE_DIR` 环境变量支持自定义凭证存储目录，适配 Render 只读文件系统（默认 `~/.zcode-proxy`，Render 上自动降级到 `/data/.zcode-proxy` 或 `/tmp/zcode-proxy/.zcode-proxy`）
> 11. **`writeStore` 优雅降级**：只读文件系统下写入失败不再崩溃，仅警告日志，保留内存中的副本让当前请求继续完成
> 12. **`.dockerignore` 优化**：排除 node_modules / 二进制文件 / 本地 config.yaml / 测试配置，加速 Docker 构建
> 13. **README 完整部署文档**：新增 Render 部署章节，含 Blueprint / 手动两种方式、两种认证模式（apikey / oauth）详细说明、完整环境变量参考表、客户端接入示例（OpenAI SDK / Anthropic SDK / Codex CLI / curl）、常见问题排查
> 14. **测试覆盖**：全套 378 测试通过，TypeScript 类型检查零错误
>
> **Render 部署两种模式**：
> - **Mode A (apikey)**：设置 `ZCODE_API_KEY` 即可，最简单
> - **Mode B (oauth)**：本地 `zcode-proxy auth login` → `zcode-proxy auth export` → 把 base64 blob 填入 `ZCODE_OAUTH_CREDENTIAL`
>
> **必填环境变量**：仅 `ZCODE_PROXY_API_KEY`（客户端访问代理的密钥）。上游认证二选一。
>
> ---

> **v2.1.4.1test1 — Responses 思考管理 + GLM 模型目录接口**
>
> 修复 Codex CLI 在 `/v1/responses` 接口下思考参数丢失的问题，并新增管理面板配置入口。
>
> **v2.1.4.1test1 关键改进**：
> 1. **Responses 思考管理**：Codex CLI 经常把 `reasoning` 字段传成 `null`（即使本地配置开了 reasoning），导致思考参数丢光。新增管理面板「代理规则 → Responses 思考管理」卡片，可勾选需要强制开启思考的模型，无论客户端发什么都会注入 `thinking:{type:"enabled"}`
> 2. **GLM 模型目录接口**：新增 `GET /admin/api/glm-models` 接口，返回完整 GLM 模型目录（含 reasoning 标记、上下文窗口、最大输出 tokens），供前端快速选择
> 3. **模型映射快速选择**：模型映射的「GLM 模型」字段 datalist 改用完整 GLM 目录（之前只用白名单），输入时能看到全部 9 个 GLM 模型作为下拉建议
> 4. **配置持久化**：`responsesThinking` 配置持久化到 `config.yaml`，支持 canonical `{models:[]}` 和简写数组两种形式
> 5. **匹配规则**：按映射后的最终 GLM 模型 id 匹配（大小写不敏感），确保模型映射 + 思考强制开启协同工作
> 6. **测试覆盖**：新增 11 个单元测试（5 个 loader + 6 个 translator），全套 378 测试通过，TypeScript 类型检查零错误
>
> **配置示例**：
> ```yaml
> responsesThinking:
>   models:
>     - glm-5.2
>     - glm-4.6
> ```
>
> ---

> **v2.1.4.1test0 — 凭证自动切换测试版**
>
> 新增凭证自动切换功能：当同一凭证连续失败达到设定阈值时，自动切换到另一个已存储的凭证继续重试。
>
> **v2.1.4.1test0 关键改进**：
> 1. **凭证自动切换**：同一凭证连续失败 N 次（含首次请求）后自动切换到另一个已存储的凭证，逐个尝试所有可用凭证（A→B→C），已试过的凭证不会重复使用
> 2. **可配置阈值**：在 dashboard「重试配置」标签页新增「凭证切换阈值」输入框，默认 5，设为 0 禁用
> 3. **多凭证支持**：支持 3+ 凭证逐个切换，每个凭证获得公平的重试机会
> 4. **持久化切换**：切换后自动持久化到凭证存储，dashboard 实时反映当前激活的凭证
> 5. **环境变量支持**：`ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD` 可覆盖 YAML 配置
>
> ---

> **v2.1.4.1 — 修复版（Windows 保存失败 + 启动提示）**
>
> 修复 v2.1.4 在 Windows 上 dashboard 保存配置失败的问题。
>
> **v2.1.4.1 关键修复**：
> 1. **Windows 保存失败修复**：`atomicWriteFile` 的 `rename` 在 Windows 上会被杀毒软件/Windows Search 索引器短暂锁文件导致 EPERM，新版加了 5 次重试 + 退避
> 2. **启动提示加强**：当 host 为 `0.0.0.0` 时，启动日志明确提示用 `http://127.0.0.1:<port>/admin` 访问 dashboard（之前用户误以为可以直接打开 `http://0.0.0.0:8080/admin`）
> 3. **config.example.yaml 加注释**：明确说明 `0.0.0.0` 是绑定地址不是访问地址
>
> ---
>
> **v2.1.4 — 全面优化版（安全加固 + 性能优化 + 资源控制）**
>
> 在 v2.1.3.5 基础上进行了一次完整的代码审查与系统性优化，覆盖 30 项发现，分 P0/P1/P2/P3 四级落地。
>
> **v2.1.4 关键改进**（按优先级）：
>
> ### P0 关键（安全/正确性）
> 1. **Admin token 时序攻击修复**：admin 控制台 token 比较改用 timingSafeEqual（之前用 `===`）
> 2. **凭证存储明文后门加固**：必须设置 `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` 才能加载明文 credentials.json
> 3. **上游 fetch 超时**：stream 10 分钟、batch 5 分钟，挂起的上游连接不再无限占用 worker
> 4. **SSE 流背压控制**：所有翻译流在 enqueue 前检查 `controller.desiredSize`，慢客户端不再导致 OOM
> 5. **console.log 猴补丁修复**：保留 Error stack，处理循环引用（之前 `JSON.stringify(Error)` 返回 `"{}"`）
>
> ### P1 高优先级（可靠性）
> 6. **网络错误默认可重试**：之前合成 502 但默认 retryableStatuses 不含 502，重试静默失效
> 7. **Retry-After HTTP-date 格式**：RFC 7231 完整支持（之前只解析 delta-seconds）
> 8. **配置原子写入 + 互斥锁**：所有 dashboard 保存改用 temp-file + rename，并发 PUT 串行化
> 9. **凭证 store 内存缓存**：9+ admin 端点不再每次磁盘读 + AES-GCM 解密
> 10. **OAuth callback server 泄漏修复**：try/finally 保证 oauth.close() 总执行
> 11. **responses-store 大小上限**：每条 256KB 上限，防止 Codex 长对话 OOM
> 12. **死代码删除**：移除 `routes-auth.ts` + `cli/login.ts`（220 LOC）
> 13. **recordStat O(n) → Map**：去重查找 O(1)
> 14. **SSE 错误日志**：malformed JSON 不再静默吞掉
>
> ### P2 中优先级（性能/架构）
> 15. **SSE 解析器去重**：3 处副本合并到 `src/utils/sse.ts`
> 16. **4xx 时不再二次构造 Request**：`lastSentBeta` 缓存实际发送的 header
> 17. **structuredClone 优化**：模块加载时一次性 freeze 而非每请求克隆
> 18. **logging.level 真正生效**：之前配置了但不被读取
> 19. **Admin log stream O(n²) → O(n)**：直接遍历 buffer 替代 find(seq)
> 20. **CORS allowlist 支持**：新增 `ZCODE_PROXY_CORS_ALLOWLIST` 环境变量
> 21. **applyStartPlanSystem 短路优化**：body 已正确时跳过 stringify
> 22. **globMatch 改用 Uint8Array**：减少分配
> 23. **defaultModel 与 models 一致性校验**
>
> ### P3 改进（DX）
> 24. **README 更新**：auto-create config.yaml 说明、`--plan=` flag、Admin Dashboard 章节、Security Notes
> 25. **tsconfig 加严**：noImplicitReturns / noFallthroughCasesInSwitch / forceConsistentCasingInFileNames
> 26. **genId 升级到 128-bit**：8 字节 → 16 字节
> 27. **集成测试隔离**：port 0（消除端口竞争）+ 临时 HOME（不污染用户凭证目录）+ 绝对路径 config
>
> 全套 **348 测试通过**（v2.1.3.5 是 329+1 失败 → v2.1.4 是 348+0 失败），TypeScript 类型检查零错误。
>
> ### 新增环境变量
> - `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` — 允许加载明文凭证文件（仅 debug/test）
> - `ZCODE_PROXY_CORS_ALLOWLIST=https://a.com,https://b.com` — CORS origin 白名单

---

## 客户端适配性

| 客户端 | 接入路径 | 状态 | 备注 |
|--------|---------|------|------|
| **Claude Code** (Anthropic CLI) | `/v1/messages` (Anthropic 原生格式) | ✅ 完全适配 | 多轮对话 + 27 工具 + thinking 已验证 |
| **Codex CLI** (OpenAI Responses) | `/v1/responses` (翻译到 Anthropic) | ✅ 完全适配 | 工具调用 + 链式续聊已验证 |
| **OpenAI 兼容客户端** | `/v1/chat/completions` (翻译到 Anthropic) | ✅ 兼容 | 早期版本已支持，未做改动 |
| **Anthropic SDK 直连** | `/v1/messages` (透传) | ✅ 兼容 | coding-plan/start-plan 均可 |

### Claude Code 接入

在 `~/.claude/settings.json` 中配置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的proxyApiKey（config.yaml中配置的）",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.7",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> 如果 `config.yaml` 中没有设置 `proxyApiKey`，则 `ANTHROPIC_AUTH_TOKEN` 可以填任意值。

### Codex CLI 接入

```bash
export OPENAI_API_KEY="your-proxy-secret"
export OPENAI_BASE_URL="http://localhost:8080/v1"
codex --model glm-5.2
```

---

## ⚠️ 维护者必读 — body-transformer 逻辑说明

**这个文件是经过 ~10 次 3001 报错迭代调试出来的，每个 transform 都是为了解决 ZCode start-plan 网关的特定拒绝场景。不要盲目简化、合并、重排序！**

完整逻辑说明在 `src/proxy/body-transformer.ts` 文件顶部的注释里（约 90 行），这里是要点摘要：

### 每个 transform 存在的原因

| Transform | 解决的问题 | 移除会怎样 |
|-----------|-----------|-----------|
| `transformUnsupportedAnthropicFields` | Claude Code 发 `thinking:{type:"adaptive"}`、`context_management`、`output_config`，GLM 不接受 | 3001 |
| `relocateSystemMessages` | Claude Code 把 system 放 `messages[].role:"system"`，Anthropic 要求放顶层 `system` | 3001 |
| `stripThinkingBlocksFromMessages` | GLM 返回 thinking_delta，Claude Code 回传时含 `thinking`/`redacted_thinking` 内容块，GLM 不接受 | 第二轮起 3001 |
| `ensureAssistantTextBlock` | thinking 剥离后 assistant 只剩 tool_use 块，网关要求 assistant 必须有 text 块 | 多轮后 3001 |
| `normalizeAllMessageContent` | string content 必须转 array；空 string 必须转非空占位 `" "` | 3001（Codex CLI 路径关键） |
| `normalizeToolResultContent` | tool_result.content 同上，string → array，空 → 非空 | 3001 |
| `sanitizeContentBlocks` | 剥离 cache_control（start-plan 全剥）+ is_error（两种模式都剥） | 3001 |
| `applyAnthropicCacheControl` | start-plan 模式下 no-op（不添加 cc）；coding-plan 给 text 块加 cc | start-plan 添加 cc 会 3001 |

### Transform 执行顺序（不能乱）

```
1. transformUnsupportedAnthropicFields    # 顶层字段清理
2. relocateSystemMessages                  # system 消息迁移
3. stripThinkingBlocksFromMessages         # 剥离 thinking 块
4. ensureAssistantTextBlock                # 补非空 text 块
5. normalizeAllMessageContent              # string content → array
6. normalizeToolResultContent              # tool_result content → array
7. sanitizeContentBlocks                   # 剥 cache_control + is_error
8. applyAnthropicCacheControl              # coding-plan 才加 cc
```

### 3001 排查指南

如果 3001 复现，按以下顺序检查代理控制台日志：

1. **`transformed request summary:`** — 查看每条消息的块类型
   - 任何 `+cc` 在非 text 块上 → `sanitizeContentBlocks` 回归
   - 任何 `tool_result/str` → `normalizeToolResultContent` 回归
   - 任何 `/+err` → `is_error` 剥离回归
   - 任何 `[N]user/str` → `normalizeAllMessageContent` 回归

2. **`anthropic-beta sent:`** — 应该只有 `claude-code-*` flag
   - 有其它 flag → `collectPassthroughHeaders` 回归

3. **`full transformed body dumped to: zcode-proxy-debug-XXX.json`** — 完整请求体
   - 把这个文件发回开发者精确分析

### ⚠️ 不要做的事

- ❌ **不要** 在 start-plan 模式添加 cache_control — 网关会 3001
- ❌ **不要** 把空 text 块改回 `text:""` — 网关会 3001
- ❌ **不要** 保留 `is_error` 字段 — 网关会 3001
- ❌ **不要** 让 string content 透传 — 网关会 3001
- ❌ **不要** 重排 transform 顺序 — `sanitizeContentBlocks` 必须在 `applyAnthropicCacheControl` 之前
- ❌ **不要** 在 `anthropic-beta` header 保留非 `claude-code-*` flag — header/body 不一致会 3001

---

## 快速启动

### Windows
1. 双击 `start.bat` 打开管理菜单
2. 首次使用：选择 **2**（OAuth 登录智谱）或 **4**（从 ZCode 导入密钥）
3. 登录成功后：选择 **1** 启动代理服务

### Linux / macOS
1. 运行 `chmod +x start.sh && ./start.sh` 打开管理菜单
2. 首次使用：选择 **2**（OAuth 登录智谱）或 **4**（从 ZCode 导入密钥）
3. 登录成功后：选择 **1** 启动代理服务

---

## 命令行用法

`zcode-proxy.exe` 本身就是一个完整的命令行工具，所有功能都可以直接通过命令行使用：

```
zcode-proxy serve [config.yaml]          启动代理服务（默认命令）
zcode-proxy auth login bigmodel          OAuth 登录智谱（自动打开浏览器）
zcode-proxy auth login zai               OAuth 登录 Z.AI（自动打开浏览器）
zcode-proxy auth login bigmodel --import 从 ZCode 桌面版导入智谱密钥
zcode-proxy auth login zai --import      从 ZCode 桌面版导入 Z.AI 密钥
zcode-proxy auth status                  查看当前登录状态
zcode-proxy auth logout                  退出登录，清除凭证
zcode-proxy version                      查看版本号
zcode-proxy help                         显示帮助
```

---

## 两种使用方式

### 方式一：apikey 模式（简单，推荐新手）

在 `config.yaml` 中直接填入 API Key：

```yaml
auth:
  mode: apikey
  apiKey: "你的API_Key"        # 智谱: 直接填 API Key；Z.AI: 填 apiKey.secretKey
```

获取 API Key 的方式：
- **智谱**：登录 https://open.bigmodel.cn → API Keys 页面创建
- **Z.AI**：登录 https://z.ai → 个人中心 → API Keys 页面创建

### 方式二：OAuth 模式（自动获取密钥）

```yaml
auth:
  mode: oauth
```

然后运行登录命令：

```bash
# 方式 A：浏览器 OAuth 登录（自动打开浏览器授权）
zcode-proxy.exe auth login bigmodel

# 方式 B：从已安装的 ZCode 桌面版直接导入密钥（免浏览器）
zcode-proxy.exe auth login bigmodel --import
```

OAuth 凭证加密存储在 `~/.zcode-proxy/credentials.json`。

#### 多账号管理

支持同时存储多套凭证，运行时通过 dashboard 切换：

1. 启动代理后访问 `http://localhost:8080/admin` 进入面板
2. 进入 **Accounts** 页面，可看到所有已存储的账号
3. 用 **Add API Key** 添加新账号，或用 **OAuth Login** 走 OAuth 流程
4. 点击 **Activate** 切换激活账号（运行时热替换，无需重启）

> 凭证存储格式为 v2 多账号格式；旧版本（v1 单账号）的 `credentials.json` 在首次加载时会自动迁移，无需手动操作。

#### OAuth 手动回调（远程/无头环境）

当浏览器自动跳转失效时，可在 dashboard 的 OAuth 页面手动粘贴回调 URL 完成授权：

1. 点击 **Start OAuth Login**，复制 Authorize URL 在浏览器中打开
2. 完成授权后，浏览器会跳转到形如 `https://zcode.z.ai/api/v1/oauth/cli/callback/zai?code=...&state=...` 的 URL
3. 复制该完整 URL，粘贴到 **Manual Callback URL** 输入框，点击 **Submit Callback URL**

---

## start-plan 套餐

如果使用 start-plan（通过 zcode.z.ai 网关），需要额外获取 JWT：

```yaml
plan: start-plan
```

```bash
# start-plan 的 JWT 会随 OAuth 登录一起获取
zcode-proxy.exe auth login bigmodel

# 或者从 ZCode 桌面版导入（同时导入 API Key + JWT）
zcode-proxy.exe auth login bigmodel --import
```

> `--import` 会读取 ZCode 桌面版的配置文件 `~/.zcode/v2/config.json`，
> 自动提取 coding-plan 的 API Key 和 start-plan 的 JWT。
> 前提是你已经在 ZCode 桌面版中登录过。

---

## config.yaml 配置说明

### 最小配置（智谱直连）

```yaml
auth:
  mode: apikey
  apiKey: "你的智谱API_Key"

provider: bigmodel
plan: coding-plan
```

### 完整配置

```yaml
server:
  port: 8080                    # 代理监听端口
  host: "0.0.0.0"

auth:
  mode: apikey                  # apikey 或 oauth
  apiKey: "YOUR_API_KEY"        # apikey 模式必填
  proxyApiKey: "your-secret"    # 客户端访问代理的密钥（可选）

provider: bigmodel              # bigmodel 或 zai
plan: coding-plan               # coding-plan 或 start-plan

providers:
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"

defaultModel: glm-5.2
models:
  - glm-4.5-air
  - glm-4.6
  - glm-4.6v
  - glm-4.7
  - glm-5
  - glm-5-turbo
  - glm-5v-turbo
  - glm-5.1
  - glm-5.2

identity:
  appVersion: "3.1.1"
  sourceTitle: "cli"
  refererOrigin: "https://zcode.z.ai"

logging:
  level: info

retry:
  maxRetries: 3                # Maximum retry attempts for 529/overloaded errors
  initialDelayMs: 1000         # Initial delay before first retry (ms)
  maxDelayMs: 8000             # Maximum delay cap (ms)
  backoffFactor: 2             # Exponential backoff multiplier
  retryableStatuses:           # HTTP status codes that trigger retry
    - 529
```

---

## 支持的模型

| 模型 | 上下文 | 最大输出 | 推理模式 |
|------|--------|---------|---------|
| glm-4.5-air | 200K | 128K | ✅ |
| glm-4.6 | 200K | 128K | ✅ |
| glm-4.6v | 200K | 128K | — |
| glm-4.7 | 200K | 128K | ✅ |
| glm-5 | 200K | 128K | ✅ |
| glm-5-turbo | 200K | 128K | ✅ |
| glm-5v-turbo | 200K | 128K | — |
| glm-5.1 | 200K | 128K | ✅ |
| glm-5.2 | **1M** | 128K | ✅ |

---

## 版本演进历史（精简）

**v2.1.3.5** — 全面优化版：13 项改进覆盖安全/内存/UX/代码质量，测试 295→348

正式版 v2.1.3.4 整合了以下 beta 版本的修复：

- **v2.1.3.11beta0** — Responses API 空 string content → 非空占位（Codex CLI 关键修复）
- **v2.1.3.10beta0** — 非空 text 占位符 + 全消息 content 标准化 + 4xx 完整 body dump
- **v2.1.3.9beta0** — start-plan 剥离所有 cache_control + tool_result content 标准化 + is_error 剥离
- **v2.1.3.8beta0** — 过滤 anthropic-beta header（只保留 claude-code-* flag）
- **v2.1.3.7beta0** — assistant 消息必须有 text 块
- **v2.1.3.6beta0** — tool_use 块上的 cache_control 剥离
- **v2.1.3.5beta0** — tool_result 块上的 cache_control 剥离
- **v2.1.3.4beta0** — 增加 3001 诊断日志
- **v2.1.3.3beta0** — 剥离 messages[].content 里的 thinking 块
- **v2.1.3.3** — Dashboard 模型映射 + thinking 无条件注入
- **v2.1.3.2** — thinking 字段重新启用（按模型能力）
- **v2.1.3.1** — Codex CLI 实战修复（连续同角色消息合并 + 非 GLM 模型 fallback）
- **v2.1.3.0** — OpenAI Responses API 适配（Codex CLI 兼容）
- **v2.1.3** — 流式重试三连修复（SSE 错误检测 + Request body 复用 + captcha token 过期）
- **v2.1.2** — Dashboard UI 全面重构
- **v0.1.x** — 多账号管理 / OAuth 回调 / 跨项目凭证互通 / 导入密钥 plan 自动识别
