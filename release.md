# Release 构建与发布指令

> 供 Agent 参考的完整构建流程。每次发版前务必按此文档执行。
>
> **关键原则**：发版已完全自动化。Agent 只需 **改版本号 + 校验脚本（如需更新）+ 打 tag**，
> 剩下的编译/打包/上传全部由 GitHub Actions 完成。**不要手动跑 `bun build` 产物上传、
> 手动 zip、手动调 GitHub API 发布。**
>
> `start.bat` / `start.sh` 已纳入仓库 `release/` 目录，随 zip 分发；但**不能无脑复用**——
> 如果 CLI 命令、菜单项、参数逻辑有变化，必须同步更新脚本并提交（见 Section 4）。

---

## 构建产物（v0.3.2.0 起，对齐上游多平台发布）

每个 Release 发布 **5 个分平台 zip + 1 个 Docker 镜像**：

| 平台 | 文件名 | 二进制 | 启动脚本 |
|------|--------|--------|---------|
| Windows x64 | `zcode-proxy-v{V}-windows-x64.zip` | `zcode-proxy.exe`（PE32+） | `start.bat`（含 `start.sh`，供 WSL/Git-Bash） |
| Linux x64 | `zcode-proxy-v{V}-linux-x64.zip` | `zcode-proxy-linux-x64`（ELF） | `start.sh` |
| Linux ARM64 | `zcode-proxy-v{V}-linux-arm64.zip` | `zcode-proxy-linux-arm64`（ELF） | `start.sh` |
| macOS x64 | `zcode-proxy-v{V}-darwin-x64.zip` | `zcode-proxy-darwin-x64`（Mach-O） | `start.sh` |
| macOS ARM64 | `zcode-proxy-v{V}-darwin-arm64.zip` | `zcode-proxy-darwin-arm64`（Mach-O） | `start.sh` |

每个 zip 内容：平台二进制 + `config.yaml`（由 `config.example.yaml` 复制）+ 启动脚本 + `README.md`（用户手册，`release/README.md`）。

`start.sh` 自动按 `uname -s`/`uname -m` 选择对应二进制，找不到时依次回退到任意已知二进制名
（覆盖 WSL/Git-Bash 跑 .exe、用户改名等场景）；macOS 被 Gatekeeper 拦截时自动打印
`xattr -d com.apple.quarantine` 修复提示。

Docker 镜像（Release 成功后自动构建推送，多架构 linux/amd64 + linux/arm64）：
`ghcr.io/{owner}/zcode-proxy:{V}` 与 `:latest`。

### Android 状态（暂不构建，与上游的差异说明）

上游 [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) 的 Release 附带安卓 APK：
其 `Android-APP` 工程（约 211MB，含 libnode.so）把服务端打成 Node bundle 在安卓上跑。
这要求 server 层是 `node:http` 实现——上游为此已把 `server.ts` 从 `Bun.serve` 迁移到
`node:createServer`。**本仓库核心仍是 `Bun.serve`（server.ts），且 SOCKS 桥
（socks-bridge.ts，844 行）依赖 `Bun.listen`/`Bun.connect`，没有 Node 等价物**；
直接移植安卓工程会在运行时崩溃。补齐路径（未来工作）：

1. `server.ts` 迁移 `node:http`（保留 Bun 运行时兼容）
2. `socks-bridge.ts` 用 `node:net` 重写（或安卓构建禁用 SOCKS 特性）
3. 移植 `Android-APP` 工程 + esbuild node bundle 脚本 + undici 超时兼容层
4. 配置安卓签名 keystore secret

---

## 1. 更新版本号（Agent 必做）

**版本号只有一个源**：`package.json` 的 `"version"` 字段。

- `src/version.ts` 从 `package.json` import（编译期内联），无需单独改
- 管理看板版本号是 `__ZCODE_PROXY_VERSION__` 占位符，由 `admin/api.ts` 在运行时替换，无需单独改
- `release/README.md` 顶部追加本次版本的更新说明（zip 内用户唯一能看到的 changelog）

```bash
VERSION="0.3.2.0"   # 替换为当前版本（不要带前导 v）
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
```

> ⚠️ GitHub Actions 会硬校验 `package.json` 版本 == tag 版本，不一致直接构建失败。
> 所以这一步必须先做完再打 tag。

### 1.1 release/README.md 的版本说明

在 `release/README.md` 顶部（紧跟标题）追加本次版本条目，沿用现有格式：
`> **v{VERSION} — 一句话标题**` + 改动列表 + 升级建议。务必写清「改了什么、影响谁」。

---

## 2. 跑测试 + 类型检查（本地预检，Agent 应做）

提交前本地先跑一遍，避免 push 上去才发现 CI 红：

```bash
bun run test         # 必须全部通过
bun run typecheck    # 必须零错误
```

> GitHub Actions 发版门禁就是这两步。本地过了，CI 基本也过。

---

## 3. 触发发布（打 tag）

```bash
VERSION="0.3.2.0"
git commit -am "release: v${VERSION}"   # 版本号/脚本/文档改动先提交
git tag "v${VERSION}"
git push origin main "v${VERSION}"      # 分支与 tag 一起推
```

推送 `v*` tag 后 Actions 自动执行：类型检查 → 全量测试 → 版本校验 →
5 平台交叉编译（`--target=bun-{windows,linux,darwin}-{x64,arm64}`）→
二进制格式校验（PE32/ELF/Mach-O）→ 原生二进制版本号冒烟 →
`start.bat` ASCII+CRLF 校验 → `start.sh` bash 语法校验 → 分平台打包 →
创建 Release 上传 5 个 zip → 构建多架构 Docker 镜像推 GHCR。

也可以用 `workflow_dispatch`（Actions 页面 "Run workflow"，填版本号）手动触发，
要求 `package.json` 已先改好版本号。

### 3.1 覆盖已存在的 tag / Release

```bash
VERSION="0.3.2.0"

# 删本地 + 远端旧 tag（关联的 Release 会变成 draft 挂在 tag 上，需手动删）
git tag -d "v${VERSION}"
git push origin :refs/tags/"v${VERSION}"

# 重新打 tag 触发构建（softprops/action-gh-release 会更新同名 Release）
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

---

## 4. 脚本变更检测（关键步骤）

**不能无脑复用仓库里的 start.bat / start.sh！** 每次发版前必须检查脚本逻辑是否需要更新。

### 4.1 触发重新生成/修改脚本的条件

| 触发条件 | 示例 |
|---------|------|
| CLI 子命令新增/删除/重命名 | 新增 `auth refresh` 命令 |
| CLI 参数变化 | `--plan=` 改名为 `--tier=` |
| 菜单项需要调整 | 新增「刷新 token」菜单项 |
| `src/index.ts` 的 `printHelp()` / `authCommand()` 改动 | 任何 CLI 入口逻辑变化 |
| OAuth 流程变化 | `src/auth/oauth.ts` / `src/admin/api.ts` `/admin/api/oauth/*` |
| 发布产物布局变化 | 二进制改名、zip 内容调整 |

### 4.2 检测方法

```bash
# 1. 检查自上次发版 tag 以来是否有 CLI 相关改动
git log --oneline "v$(node -p "require('./package.json').version")"..HEAD -- src/index.ts src/auth/oauth.ts src/auth/resolver.ts

# 2. 打印当前 CLI 帮助，确认脚本里的命令都还在
bun run src/index.ts help

# 3. 提取脚本里的命令并与帮助对比
grep -oE 'zcode-proxy(\.exe)? [a-z ]+' release/start.bat release/start.sh | sort -u

# 4. start.sh 语法检查
bash -n release/start.sh
```

### 4.3 脚本硬性要求

**start.bat**：
- 必须纯 ASCII（Windows CMD 默认 GBK，中文乱码会导致命令被截断）
- 必须 CRLF 换行（LF 会让 `if/goto` 多行结构解析失败）
- CI 会做同样校验，不合格直接构建失败

**start.sh**：
- `bash -n` 语法通过（CI 校验）
- 二进制一律用 `./$BIN` 相对路径执行（bash 不会从 cwd 找裸命令名）
- 平台检测基于 `uname -s` + `uname -m`，覆盖 5 个发布平台 + WSL/Git-Bash 回退
- 修改后必须提交进仓库（否则下次发版又回到旧版）

---

## 5. 踩坑清单

| 坑 | 症状 | 解决 |
|----|------|------|
| 没加 `--target=bun-<platform>` | Windows 报"不兼容的16位应用程序"；macOS/Linux exec 格式错误 | workflow 已按平台固定 target；本地不要手编产物 |
| bat 含中文 | CMD 乱码，命令被截断 | 全英文（CI 校验 ASCII） |
| bat 用 LF 换行 | `if/goto` 解析失败 | 必须 CRLF（CI 校验） |
| start.sh 裸命令名执行 | `command not found`（bash 不搜 cwd） | 一律 `./$BIN` |
| macOS 拦截未签名二进制 | "cannot be opened"/SIGKILL | zip 说明已含 `xattr -d com.apple.quarantine` 提示，start.sh 失败时自动打印 |
| zip 没含 config.yaml | 用户不知道怎么配置 | workflow 固定从 example 复制 |
| OAuth 登录未指定 plan | 凭证默认 coding-plan，用户可能要 start-plan | 脚本每项都显式传 `--plan=` |
| **无脑复用脚本不检查 CLI 变更** | 脚本命令与实际 CLI 不匹配，用户运行报错 | 每次发版必须执行 Section 4 |
| **版本号与 tag 不一致就打 tag** | CI 版本校验步直接失败 | Section 1 先改好 package.json |
| **手动删了 Release 没删 tag** | 重新推同名 tag 后 Release 内容错乱 | 覆盖发版按 Section 3.1 顺序删 tag 重打 |

---

## 6. Plan 系统说明（脚本菜单背景）

项目支持两种计划，决定上游请求路由：

| Plan | 上游地址 | 认证方式 | 用途 |
|------|---------|---------|------|
| `coding-plan` | `{provider}.anthropicBase` / `{provider}.openaiBase` | `x-api-key: {apiKey}` | API Key 直连 |
| `start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/chat/completions` | `Authorization: Bearer {jwt}` + 验证码 token | 通过 ZCode 网关（free 试用层） |

**Plan 在以下位置生效**：
1. **CLI** — `auth login bigmodel --plan=start-plan`
2. **Dashboard** — OAuth/Add Key/Import 均有 Plan 选择器
3. **账号表** — Plan 列可直接下拉修改
4. **serve 启动** — 激活账号的 plan 会覆盖 config.yaml 的全局 plan

**凭证存储中的 plan 标签**：
- 旧凭证（v1 迁移或早期导入）可能没有 plan 字段 → 回退 config.yaml
- 通过 Dashboard 的 Plan 下拉可以给任何账号设置/修改 plan
- 修改激活账号的 plan 会自动同步到运行时 config

**导入 ZCode 配置时的 plan 行为**：
- `--plan=coding-plan`：读取 `builtin:{provider}-coding-plan` 的 API Key，同时捕获 start-plan JWT（如有）
- `--plan=start-plan`：以 `builtin:{provider}-start-plan` 的 JWT 为主凭证，coding-plan API Key 作补充标识
- 如果只有 start-plan token 没有 coding-plan key，使用 `--plan=start-plan` 导入，会给出提示
