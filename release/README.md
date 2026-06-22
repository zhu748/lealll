# zcode-proxy 使用说明

> **v2.1.3 / v0.1.9 — 流式重试三连修复（正式版）**
> - **修复 SSE 错误检测**：GLM 网关在流式请求失败时会返回 HTTP 200 + SSE 流，把 529 错误藏在流里。代理现在能识别这种"隐身错误"并触发重试
> - **修复重试时 Request body 复用 bug**：之前每次重试都复用同一个 Request 对象，导致 body 已被消耗，所有重试都失败。现在每次重试都构建全新的 Request
> - **修复重试时 captcha token 过期 bug**：start-plan 模式下 captcha token 只有 45 秒有效期，重试等待期间容易过期导致 403。现在每次重试前都会刷新 token，遇到 403 自动重新求解
> - **改进错误日志**：catch 块现在会打印实际错误信息（之前只打 "network error"）
> - **新增 16 个单元测试**：完整测试套件 224/224 通过
>
> **v2.1.2 / v0.1.8 — Dashboard UI 全面重构**
> - **设计令牌系统**：完整的 spacing / radius / shadow / typography / motion 令牌，更柔和的深色配色（4 级文本灰度）
> - **侧边栏重构**：导航分组（监控 / 配置 / 凭证）+ SVG 图标 + 修复 footer `margin-top:auto` + `margin-top:24px` 冲突
> - **概览页**：新增 Hero 状态卡（运行/异常带不同颜色）+ 统计卡带分类色图标 + 悬浮抬升动画
> - **设置页（最大改动）**：长表单拆成 7 个 tab（服务器/提供商/认证/模型/重试/身份/日志），底部 sticky 保存栏，每个字段加 help 文案
> - **表格升级**：sticky header、uppercase 字段名、空状态带 SVG 图标
> - **统计页**：新增成功率进度条（绿/红/黄三段）
> - **日志页**：按级别着色（error 红 / warn 黄 / info 蓝 / debug 灰），顶部"实时"状态徽章
> - **Toast 重写**：顶部居中、带图标、可点击关闭、滑入/滑出动画
> - **OAuth 等待状态**：脉冲点动画
> - **响应式**：1100/900/600px 三档断点，900px 以下侧边栏自动折叠为图标栏
> - **完全向后兼容**：所有 JS 函数名与 DOM ID 保留
>
> **v0.1.7 修复版本**
> - **修复 v1 凭证无法在 dashboard 修改 plan 的 bug**：v1 凭证（来自 zcode-api-ref）首次加载时自动迁移为 v2 格式并持久化，避免每次读取都生成新 ID 导致 setAccountPlan 找不到账号
> - **dashboard 修改 plan 后立即生效**：内存里的凭证热替换，无需重启
> - **dashboard 显示正确的推断 plan**：v1 凭证 + 有 JWT 时显示 "Start Plan"，不再误显示为 "Coding Plan"
>
> **v0.1.6 修复版本**
> - **v1 凭证（来自 zcode-api-ref）自动推断 plan**：加载无 plan 字段的 v1 凭证时，如果带 JWT 则自动推断为 start-plan，否则跟随 config.yaml
> - **启动日志显示 plan 来源**：清晰说明 plan 是来自凭证显式字段、JWT 推断、还是 config.yaml
>
> **v0.1.5 修复版本**
> - **跨项目凭证互通**：zhipu 现在能直接读取 zcode-api-ref (TriDefender/zcode-api) 创建的 `credentials.json`，无需重新登录
> - **解密 fallback 链扩充**：依次尝试 (1) 当前 SHA-256/Node-crypto 格式 → (2) 早期 SHA-256/WebCrypto 格式 → (3) zcode-api-ref 的 XOR-fold/WebCrypto 格式
>
> **v0.1.4 修复版本**
> - **导入密钥时自动识别 plan**：从 ZCode config 导入时，自动检测 `enabled: true` 的那个 plan 作为账号的 plan，无需用户手动选择
> - **`--plan=` 改为可选的强制覆盖**：默认走自动识别，加 `--plan=` 可强制指定
> - **多账户场景完整支持**：可以多次 `--import` 导入不同 plan 的账号（自动 + 强制组合），dashboard 切换账号时各自带各自的 plan
>
> **v0.1.3 修复版本**
> - **修复 start.bat 导入菜单静默默认 coding-plan 的问题**：菜单 6/7 拆成 4 项 (Bigmodel/Z.AI × Coding/Start Plan)，每项都明确传 `--plan=` flag
>
> **v0.1.2 修复版本**
> - **修复导入密钥时 "Failed to decrypt credential store" 报错**：当 `~/.zcode-proxy/credentials.json` 损坏或换机器/换用户名后无法解密时，自动备份旧文件并重新创建，不再阻塞登录
>
> **v0.1.1 修复版本**
> - **修复 admin 面板 ENOENT 报错**：编译后的 exe 不再因找不到 `dashboard.html` 而崩溃
> - **修复 start.bat 启动时变成 coding-plan 的问题**：`--config` flag 现在能正确解析
> - **修复双击 exe 切换 start-plan 时闪退**：错误信息现在会清晰显示并暂停 15 秒
> - **修复 dashboard 切换 plan 后重启丢失**：plan 变更会持久化到 config.yaml
>
> **v0.1.0 新特性**
> - **多账号管理**：支持同时存储多套凭证（智谱 / Z.AI），运行时一键切换
> - **OAuth 回调 URL 手动输入**：当自动轮询失败或远程服务器无浏览器时，可手动粘贴回调 URL 完成授权
> - **路由规则持久化**：dashboard 中的 per-model 路由规则会保存到 config.yaml
> - **统计重置**：dashboard 支持手动清零请求统计
> - **修复日志流**：日志面板 WebSocket 改用 SSE (EventSource)，不再断连

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

## Claude Code 对接

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
