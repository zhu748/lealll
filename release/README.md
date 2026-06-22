# zcode-proxy 使用说明

> **v2.1.3.5 — 全面优化版（安全加固 + 测试补全 + UX 提升）**
>
> 在 v2.1.3.4 稳定版基础上进行了 13 项优化，覆盖安全、内存、UX、代码质量四个维度。
>
> **v2.1.3.5 关键改进**（按重要性排序）：
> 1. **调试文件泄露修复**：4xx 错误的请求快照不再写入磁盘，改为内存环形缓冲（最多 20 条），新增管理面板「调试转储」页面
> 2. **CORS 安全加固**：从 `*` 改为 echo origin，防止第三方网站跨域读取响应
> 3. **未配置 proxyApiKey 警告**：启动时醒目提示，避免开放代理被滥用
> 4. **优雅关闭**：等待在途请求最长 30s 完成，不再强杀 SSE 流
> 5. **/verify 安全语义**：未配置 proxyApiKey 时返回 `{warning: "no_auth"}`，前端展示警告横幅
> 6. **OAuth flow 内存泄漏修复**：5 分钟定时清理过期 flow
> 7. **统计双计数修复**：同一请求重试时不再被记录为多条
> 8. **SSE 日志缓冲索引修复**：改用单调 seq 号，splice 后客户端不丢日志
> 9. **前端 XSS 加固**：所有用户数据 escapeHtml；Token 改用 sessionStorage
> 10. **配置热生效反馈**：保存返回 `{requiresRestart, restartFields, hotApplied}`
> 11. **概览页统计自动刷新**：不再静止不动
> 12. **路由规则 glob 匹配**：实现真正的 `*` 和 `?` 通配符（之前是隐藏 no-op）
> 13. **代码质量优化**：服务器路由 Map O(1) 查找；加密模块 decrypt 三重尝试合并；配置验证增强
>
> 全套 **348 测试通过**（v2.1.3.4 是 295），TypeScript 类型检查零错误。

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
