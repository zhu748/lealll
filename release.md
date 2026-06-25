# Release 构建与发布指令

> 供 Agent 参考的完整构建流程。每次发版前务必按此文档执行。
>
> **关键原则**：发版已完全自动化。Agent 只需 **改版本号 + 改脚本（如需）+ 打 tag**，
> 剩下的编译/打包/上传全部由 GitHub Actions 完成。**不要再手动跑 `bun build`、手动 zip、手动调 GitHub API。**
>
> `start.bat` / `start.sh` 已纳入仓库 `release/` 目录，默认复用；但**不能无脑复用**——
> 如果 CLI 命令、菜单项、参数逻辑有变化，必须重新生成脚本并提交到仓库（见 Section 3）。

---

## 构建产物（不变）

无论谁来构建，最终产物完全一致，就是这一个 zip：

```
zcode-proxy-v{VERSION}.zip
├── zcode-proxy.exe    ← bun build --compile --target=bun-windows-x64 编译的 Windows PE
├── config.yaml        ← 由 config.example.yaml 复制
├── start.bat          ← 仓库内（Section 3 校验/更新，ASCII + CRLF）
├── start.sh           ← 仓库内（Section 3 校验/更新，可执行）
└── README.md          ← 仓库内（Section 1 更新版本号）
```

---

## 1. 更新版本号（Agent 必做）

三处版本号必须同步，且与即将打的 tag 完全一致：

```bash
VERSION="2.1.4.2"   # 替换为当前版本（不要带前导 v）

# package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json

# src/index.ts (VERSION 常量)
sed -i "s/const VERSION = \".*\"/const VERSION = \"$VERSION\"/" src/index.ts

# src/admin/dashboard.html.txt (侧栏版本号，带 v 前缀)
sed -i "s|<span>v[^<]*</span>|<span>v$VERSION</span>|" src/admin/dashboard.html.txt

# release/README.md (顶部版本说明，手动追加本次改进列表)
```

> ⚠️ GitHub Actions 会**硬校验**这三处必须等于 tag 版本号，不一致直接构建失败。
> 所以这一步必须先做完，再打 tag。

### 1.1 release/README.md 的版本说明

在 `release/README.md` 顶部追加本次版本的更新条目（沿用现有格式：`> **v{VERSION} — 一句话标题**` + 改进列表）。
这是 zip 包内用户唯一能看到的更新说明，务必写清「改了什么、影响谁」。

---

## 2. 跑测试 + 类型检查（本地预检，Agent 应做）

提交前本地先跑一遍，避免 push 上去才发现 CI 红：

```bash
bun test             # 必须全部通过
bun x tsc --noEmit   # 必须零错误
```

> GitHub Actions 也会跑这两步作为发版门禁。本地过了，CI 基本也过。

---

## 3. 脚本变更检测（关键步骤）

**不能无脑复用仓库里的 start.bat / start.sh！** 每次发版前必须检查脚本逻辑是否需要更新。

### 3.1 检测时机

以下任一情况发生时，**必须重新生成脚本**：

| 触发条件 | 示例 |
|---------|------|
| CLI 子命令新增/删除/重命名 | 新增 `auth refresh` 命令 |
| CLI 参数变化 | `--plan=` 改名为 `--tier=` |
| 菜单项需要调整 | 新增"刷新 token"菜单项 |
| `src/index.ts` 的 `printHelp()` 或 `authCommand()` 改动 | 任何 CLI 入口逻辑变化 |
| OAuth 流程变化 | `src/auth/oauth.ts` / `src/admin/api.ts` `/admin/api/oauth/*` |

### 3.2 检测方法

```bash
# 1. 检查自上次发版 tag 以来是否有 CLI 相关改动
git log --oneline v$(node -p "require('./package.json').version")..HEAD -- src/index.ts src/cli/ src/auth/oauth.ts src/auth/resolver.ts

# 2. 打印当前 CLI 帮助，确认 start.bat / start.sh 里的命令都还在
bun run src/index.ts help

# 3. 对比脚本里的命令是否都在 help 输出里
grep -oE 'zcode-proxy\.exe [a-z ]+' release/start.bat | sort -u
grep -oE 'zcode-proxy\.exe [a-z ]+' release/start.sh | sort -u
```

### 3.3 如果脚本需要更新

检测到 CLI 逻辑变化时，**必须**重新生成脚本并提交仓库（生成步骤见下方折叠块）。

<details>
<summary>4.3.1 生成 start.bat（点开）</summary>

**关键要求**：
- **必须纯 ASCII**，不能有中文（Windows CMD 默认 GBK 编码，中文会乱码）
- **必须 CRLF 换行符**（LF 会导致 `if/goto` 等多行结构解析失败）
- 菜单项必须与 `src/index.ts` 的 CLI 命令一一对应

```bash
cat > release/start.bat << 'BATCHEOF'
@echo off
echo.
echo ============================================
echo          zcode-proxy Manager
echo ============================================
echo.
echo   1. Start proxy server
echo   2. OAuth login (Bigmodel) - Coding Plan
echo   3. OAuth login (Z.AI) - Coding Plan
echo   4. OAuth login (Bigmodel) - Start Plan
echo   5. OAuth login (Z.AI) - Start Plan
echo   6. Import key from ZCode (Bigmodel) - Coding Plan
echo   7. Import key from ZCode (Z.AI) - Coding Plan
echo   8. Import key from ZCode (Bigmodel) - Start Plan
echo   9. Import key from ZCode (Z.AI) - Start Plan
echo   a. Check login status
echo   b. Logout
echo   0. Exit
echo.
set /p choice=Select: 

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto login_bigmodel_cp
if "%choice%"=="3" goto login_zai_cp
if "%choice%"=="4" goto login_bigmodel_sp
if "%choice%"=="5" goto login_zai_sp
if "%choice%"=="6" goto import_bigmodel_cp
if "%choice%"=="7" goto import_zai_cp
if "%choice%"=="8" goto import_bigmodel_sp
if "%choice%"=="9" goto import_zai_sp
if "%choice%"=="a" goto status
if "%choice%"=="b" goto logout
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
zcode-proxy.exe serve config.yaml
pause
goto end

:login_bigmodel_cp
echo.
echo Starting Bigmodel OAuth login (Coding Plan)...
zcode-proxy.exe auth login bigmodel --plan=coding-plan
pause
goto end

:login_zai_cp
echo.
echo Starting Z.AI OAuth login (Coding Plan)...
zcode-proxy.exe auth login zai --plan=coding-plan
pause
goto end

:login_bigmodel_sp
echo.
echo Starting Bigmodel OAuth login (Start Plan)...
zcode-proxy.exe auth login bigmodel --plan=start-plan
pause
goto end

:login_zai_sp
echo.
echo Starting Z.AI OAuth login (Start Plan)...
zcode-proxy.exe auth login zai --plan=start-plan
pause
goto end

:import_bigmodel_cp
echo.
echo Importing key from ZCode (Bigmodel, Coding Plan)...
zcode-proxy.exe auth login bigmodel --import --plan=coding-plan
pause
goto end

:import_zai_cp
echo.
echo Importing key from ZCode (Z.AI, Coding Plan)...
zcode-proxy.exe auth login zai --import --plan=coding-plan
pause
goto end

:import_bigmodel_sp
echo.
echo Importing key from ZCode (Bigmodel, Start Plan)...
zcode-proxy.exe auth login bigmodel --import --plan=start-plan
pause
goto end

:import_zai_sp
echo.
echo Importing key from ZCode (Z.AI, Start Plan)...
zcode-proxy.exe auth login zai --import --plan=start-plan
pause
goto end

:status
echo.
zcode-proxy.exe auth status
pause
goto end

:logout
echo.
zcode-proxy.exe auth logout
pause
goto end

:end
BATCHEOF

# 转 CRLF
sed -i 's/$/\r/' release/start.bat
```

校验：
```bash
file release/start.bat
# 期望: DOS batch file, ASCII text, with CRLF line terminators
if LC_ALL=C grep -nP '[^\x00-\x7F]' release/start.bat; then
  echo "❌ start.bat contains non-ASCII characters!"; exit 1
fi
```
（GitHub Actions 也会做同样的 ASCII + CRLF 校验，不合格直接构建失败。）
</details>

<details>
<summary>4.3.2 生成 start.sh（点开）</summary>

```bash
cat > release/start.sh << 'SHEOF'
#!/usr/bin/env bash

echo ""
echo "============================================"
echo "         zcode-proxy Manager"
echo "============================================"
echo ""
echo "  1. Start proxy server"
echo "  2. OAuth login (Bigmodel) - Coding Plan"
echo "  3. OAuth login (Z.AI) - Coding Plan"
echo "  4. OAuth login (Bigmodel) - Start Plan"
echo "  5. OAuth login (Z.AI) - Start Plan"
echo "  6. Import key from ZCode (Bigmodel) - Coding Plan"
echo "  7. Import key from ZCode (Z.AI) - Coding Plan"
echo "  8. Import key from ZCode (Bigmodel) - Start Plan"
echo "  9. Import key from ZCode (Z.AI) - Start Plan"
echo "  a. Check login status"
echo "  b. Logout"
echo "  0. Exit"
echo ""
read -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    chmod +x zcode-proxy.exe
    ./zcode-proxy.exe serve config.yaml
    ;;
  2)
    echo ""
    echo "Starting Bigmodel OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=coding-plan
    ;;
  3)
    echo ""
    echo "Starting Z.AI OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=coding-plan
    ;;
  4)
    echo ""
    echo "Starting Bigmodel OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=start-plan
    ;;
  5)
    echo ""
    echo "Starting Z.AI OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=start-plan
    ;;
  6)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Coding Plan)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import --plan=coding-plan
    ;;
  7)
    echo ""
    echo "Importing key from ZCode (Z.AI, Coding Plan)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import --plan=coding-plan
    ;;
  8)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Start Plan)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import --plan=start-plan
    ;;
  9)
    echo ""
    echo "Importing key from ZCode (Z.AI, Start Plan)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import --plan=start-plan
    ;;
  a)
    echo ""
    ./zcode-proxy.exe auth status
    ;;
  b)
    echo ""
    ./zcode-proxy.exe auth logout
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
SHEOF

chmod +x release/start.sh
```
</details>

### 3.4 如果脚本无需更新（默认情况）

直接复用仓库里的脚本即可。GitHub Actions 仍会做 ASCII + CRLF 校验，校验不过会失败。

---

## 4. 提交并打 tag 触发自动构建（核心发版动作）

完成 Section 1/2/3 后，提交改动并打 tag：

```bash
VERSION=$(node -p "require('./package.json').version")

git add -A
git commit -m "release: v${VERSION}"
git push

# 打 tag —— 这一步触发 GitHub Actions 自动构建
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

打完 tag 后，去仓库的 **Actions** 标签页查看构建进度：
`https://github.com/zhu748/lealll/actions`

### 4.1 GitHub Actions 做了什么

workflow 文件：`.github/workflows/release.yml`，触发方式：

| 触发方式 | 何时用 |
|---------|--------|
| **push tag `v*`**（推荐） | 打 `v2.1.4.2` 这种 tag 自动触发 |
| **workflow_dispatch**（手动按钮） | 仓库 Actions 页 → 选 Release workflow → Run workflow → 填版本号 |

workflow 执行步骤（全程无需人工干预）：
1. **Checkout** 代码
2. **Setup Bun**（固定 1.3.14，与本地一致）
3. **bun install** 装依赖
4. **tsc --noEmit** 类型检查（门禁，不过则失败）
5. **bun test** 测试（门禁，不过则失败）
6. **校验三处版本号** 等于 tag 版本号（门禁）
7. **bun build --compile --target=bun-windows-x64** 交叉编译 Windows exe
8. **校验 exe 是 PE32+**（防止漏加 --target 编出 ELF）
9. **复制 config.yaml**、**校验 start.bat ASCII+CRLF**、**chmod start.sh**
10. **zip 打包** 五个文件
11. **softprops/action-gh-release 创建 Release + 上传 zip**

完成后 GitHub Releases 页会出现 `zcode-proxy v{VERSION}`，zip 作为附件挂在下面。

### 4.2 手动触发（workflow_dispatch）

如果不想打 tag（比如想重新发同一个版本），也可以在 GitHub 网页手动触发：
1. 打开 `https://github.com/zhu748/lealll/actions/workflows/release.yml`
2. 点 **Run workflow** → 输入版本号（如 `2.1.4.2`，不带 v）→ 运行

> 注意：手动触发时，代码里三处版本号仍必须等于你填的版本号（workflow 会校验）。

### 4.3 发版失败的常见原因

| 症状 | 原因 | 解决 |
|------|------|------|
| CI 在「Verify version markers」步失败 | package.json / index.ts / dashboard 三处版本号与 tag 不一致 | 回 Section 1 同步版本号，重新打 tag |
| CI 在「Tests」或「Type check」步失败 | 测试没过 / 类型有错 | 回 Section 2 修复 |
| CI 在「Cross-compile」后「Verify exe format」失败 | bun 版本异常漏了 --target | 确认 workflow 里 `--target=bun-windows-x64` 没被删 |
| CI 在「Guard start.bat」失败 | start.bat 含中文 / 不是 CRLF | 回 Section 3.3 重新生成 |
| Release 创建成功但没附件 | 上传步失败（偶发网络） | 在 Actions 页重跑该 workflow |

---

## 5. 重新发同一个版本（覆盖已有 Release）

如果 `v{VERSION}` 这个 tag / Release 已存在，需要覆盖：

```bash
VERSION="2.1.4.2"   # 要覆盖的版本

# 删除本地和远端旧 tag
git tag -d "v${VERSION}"
git push origin :refs/tags/"v${VERSION}"

# 重新打 tag 触发构建（会重建 Release）
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

或者用 `workflow_dispatch` 手动触发——它会用同名 tag，如果 Release 已存在会更新而非报错。

---

## 6. 踩坑清单

| 坑 | 症状 | 解决 |
|----|------|------|
| 没加 `--target=bun-windows-x64` | Windows 报"不兼容的16位应用程序" | workflow 已固定加 target；本地不要手编 |
| bat 文件含中文 | CMD 乱码，命令被截断 | 全部用英文（仓库内 start.bat 已合规，CI 会校验） |
| bat 文件用 LF 换行 | `if/goto` 解析失败，命令被截断 | 必须 CRLF（`sed -i 's/$/\r/'`） |
| zip 包没含 config.yaml | 用户不知道怎么配置 | workflow 已固定包含 |
| OAuth 登录未指定 plan | 凭证默认 coding-plan，但用户可能需要 start-plan | 必须传 `--plan=` 参数 |
| 导入 ZCode 不区分 plan | 只读 coding-plan key，start-plan 用户导入失败 | 传 `--plan=start-plan` |
| 旧凭证无 plan 字段 | 启动时 plan 为 undefined | 自动回退 config.yaml 的全局 plan，无需处理 |
| **无脑复用脚本不检查 CLI 变更** | 脚本里的命令与实际 CLI 不匹配，用户运行报错 | 每次发版必须执行 Section 3 |
| **重新生成脚本但没提交到仓库** | 下次发版又得重写一遍 | Section 3 改完必须 commit 进仓库 |
| **三处版本号不一致就打 tag** | CI 在版本校验步直接失败 | Section 1 必须三处同步后再打 tag |

---

## 7. Plan 系统说明

项目支持两种计划，决定上游请求路由：

| Plan | 上游地址 | 认证方式 | 用途 |
|------|---------|---------|------|
| `coding-plan` | `{provider}.anthropicBase` / `{provider}.openaiBase` | `x-api-key: {apiKey}` | API Key 直连 |
| `start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | `Authorization: Bearer {jwt}` | 通过 ZCode 网关 |

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
