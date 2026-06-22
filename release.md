# Release 构建与发布指令

> 供 Agent 参考的完整构建流程。每次发版前务必按此文档执行。
>
> **关键原则**：`start.bat` / `start.sh` 已纳入仓库 `release/` 目录，**默认复用**。
> 但**不能无脑复用**——如果 CLI 命令、菜单项、参数逻辑有变化，必须重新生成脚本并提交到仓库。
> 详见 Section 4 的「脚本变更检测」流程。

---

## 0. 前置准备

```bash
cd /home/z/my-project/lealll
git pull
```

确认 `release/` 目录已包含：
- `start.bat`  — Windows 启动脚本（仓库内，ASCII + CRLF）
- `start.sh`   — Linux/macOS 启动脚本（仓库内，可执行）
- `README.md`  — 使用说明（仓库内，每次发版时更新版本号）

---

## 1. 更新版本号

三处版本号必须同步：

```bash
VERSION="2.1.3.5"   # 替换为当前版本

# package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json

# src/index.ts (VERSION 常量)
sed -i "s/const VERSION = \".*\"/const VERSION = \"$VERSION\"/" src/index.ts

# src/admin/dashboard.html.txt (侧栏版本号)
sed -i "s|<span>v2\.[0-9.]*</span>|<span>v$VERSION</span>|" src/admin/dashboard.html.txt

# release/README.md (顶部版本说明，手动更新改进列表)
```

---

## 2. 跑测试 + 类型检查

```bash
bun test             # 必须全部通过
bun x tsc --noEmit   # 必须零错误
```

---

## 3. 编译 Windows 可执行文件

```bash
cd /home/z/my-project/lealll

# 必须加 --target=bun-windows-x64，否则编译出的是 Linux ELF 格式，Windows 无法运行
bun build --compile \
  --define "require.resolve=undefined" \
  --target=bun-windows-x64 \
  src/index.ts \
  --outfile release/zcode-proxy.exe
```

验证格式：
```bash
file release/zcode-proxy.exe
# 必须输出: PE32+ executable for MS Windows 6.00 (console), x86-64
# 如果输出 ELF 64-bit，说明忘了加 --target，Windows 会报"不兼容的16位应用程序"
```

---

## 4. 脚本变更检测（关键步骤）

**不能无脑复用仓库里的 start.bat / start.sh！** 每次发版前必须检查脚本逻辑是否需要更新。

### 4.1 检测时机

以下任一情况发生时，**必须重新生成脚本**：

| 触发条件 | 示例 |
|---------|------|
| CLI 子命令新增/删除/重命名 | 新增 `auth refresh` 命令 |
| CLI 参数变化 | `--plan=` 改名为 `--tier=` |
| 菜单项需要调整 | 新增"刷新 token"菜单项 |
| `src/index.ts` 的 `printHelp()` 或 `authCommand()` 改动 | 任何 CLI 入口逻辑变化 |
| `src/cli/login.ts` 改动 | OAuth 流程变化 |

### 4.2 检测方法

```bash
cd /home/z/my-project/lealll

# 1. 检查 src/index.ts 自上次发版以来是否有 CLI 相关改动
git log --oneline v$(node -p "require('./package.json').version")..HEAD -- src/index.ts src/cli/ src/auth/oauth.ts src/auth/resolver.ts

# 2. 如果上面有 commit，对比当前脚本与 CLI 实际支持的命令
#    打印当前 CLI 帮助：
bun run src/index.ts help

# 3. 检查 start.bat / start.sh 里的命令是否都还在 help 输出里
grep -oE 'zcode-proxy\.exe [a-z ]+' release/start.bat | sort -u
grep -oE 'zcode-proxy\.exe [a-z ]+' release/start.sh | sort -u
```

### 4.3 如果脚本需要更新

如果检测到 CLI 逻辑变化，**必须**按以下流程重新生成脚本并提交到仓库：

#### 4.3.1 生成 start.bat

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

# 转换为 CRLF 换行符
sed -i 's/$/\r/' release/start.bat
```

验证：
```bash
file release/start.bat
# 应输出: DOS batch file, ASCII text, with CRLF line terminators

# 纯 ASCII 检查
if LC_ALL=C grep -P '[^\x00-\x7F]' release/start.bat; then
  echo "❌ start.bat contains non-ASCII characters!"
  exit 1
fi
```

#### 4.3.2 生成 start.sh

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

#### 4.3.3 提交脚本更新到仓库

重新生成的脚本**必须**提交到仓库，这样下次发版才能复用：

```bash
git add release/start.bat release/start.sh
git commit -m "release: update start scripts for CLI changes

- Sync menu items with current CLI commands
- Reason: <填写触发更新的具体原因>"
```

### 4.4 如果脚本无需更新（默认情况）

直接复用仓库里的脚本，但仍然要做格式校验：

```bash
# start.bat 必须是 ASCII + CRLF
file release/start.bat
# 期望: DOS batch file, ASCII text, with CRLF line terminators

if ! LC_ALL=C grep -P '[^\x00-\x7F]' release/start.bat > /dev/null; then
  echo "✓ start.bat is pure ASCII"
else
  echo "❌ start.bat contains non-ASCII — restore from git"
  git checkout main -- release/start.bat
fi

if file release/start.bat | grep -q "CRLF"; then
  echo "✓ start.bat uses CRLF"
else
  echo "❌ start.bat is NOT CRLF — fixing"
  sed -i 's/$/\r/' release/start.bat
fi

# start.sh 必须可执行
[ -x release/start.sh ] && echo "✓ start.sh is executable" || chmod +x release/start.sh
```

---

## 5. 准备 config.yaml

```bash
cp config.example.yaml release/config.yaml
```

最终 release/ 目录结构：
```
release/
├── zcode-proxy.exe    ← Section 3 编译的
├── config.yaml        ← 本步骤复制
├── start.bat          ← 仓库内（Section 4 校验/更新）
├── start.sh           ← 仓库内（Section 4 校验/更新）
└── README.md          ← 仓库内（Section 1 更新版本号）
```

---

## 6. 打包 zip

```bash
cd /home/z/my-project/lealll
VERSION=$(node -p "require('./package.json').version")

cd release
zip -9 ../zcode-proxy-v${VERSION}.zip zcode-proxy.exe config.yaml start.bat start.sh README.md
cd ..
```

---

## 7. 推送代码到 GitHub

```bash
cd /home/z/my-project/lealll

# zip / exe / config.yaml 不应提交到仓库（.gitignore 已包含 *.zip）
git status   # 确认只有 release/README.md 或 release/start.* 的改动待提交

git add -A
git commit -m "release: v${VERSION}"
git push https://{用户名}:{token}@github.com/zhu748/lealll.git main
```

---

## 8. 创建 GitHub Release 并上传

```bash
cd /home/z/my-project/lealll
VERSION=$(node -p "require('./package.json').version")
TOKEN="{token}"
REPO="zhu748/lealll"

# 创建 Release
RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "{
    \"tag_name\": \"v$VERSION\",
    \"target_commitish\": \"main\",
    \"name\": \"zcode-proxy v$VERSION\",
    \"body\": \"## zcode-proxy v$VERSION\\n\\n详见 release/README.md\\n\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 上传 zip 附件
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @zcode-proxy-v${VERSION}.zip \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=zcode-proxy-v${VERSION}.zip"
```

### 8.1 如果已有同版本 Release（重新发版）

```bash
# 查询已有 asset
ASSET_IDS=$(curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/$REPO/releases/tags/v$VERSION | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(a['id']) for a in d.get('assets',[])]")

# 删除所有旧 asset
for ASSET_ID in $ASSET_IDS; do
  curl -s -X DELETE \
    -H "Authorization: token $TOKEN" \
    https://api.github.com/repos/$REPO/releases/assets/$ASSET_ID
done

# 获取 Release ID
RELEASE_ID=$(curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/$REPO/releases/tags/v$VERSION | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 再上传新的
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @zcode-proxy-v${VERSION}.zip \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=zcode-proxy-v${VERSION}.zip"
```

### 8.2 如果需要更新已有 Release 的描述

```bash
curl -s -X PATCH \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/$REPO/releases/$RELEASE_ID \
  -d "$(jq -n --arg body "$(cat /tmp/release-body.md)" '{body: $body}')"
```

---

## 9. 清理 token

推送/上传完成后，立即从 remote URL 中移除 token，并提醒用户去 GitHub 删除 token：

```bash
git remote set-url origin "https://github.com/zhu748/lealll.git"
```

> ⚠️ **安全提示**：每次发版用的临时 token，发版完成后必须立刻去 https://github.com/settings/tokens 删除。

---

## 10. 踩坑清单

| 坑 | 症状 | 解决 |
|----|------|------|
| 没加 `--target=bun-windows-x64` | Windows 报"不兼容的16位应用程序" | 编译时必须加 target |
| bat 文件含中文 | CMD 乱码，命令被截断 | 全部用英文（仓库内 start.bat 已合规，不要重写） |
| bat 文件用 LF 换行 | `if/goto` 解析失败，命令被截断 | 必须 CRLF（`sed -i 's/$/\r/'`） |
| zip 包没含 config.yaml | 用户不知道怎么配置 | 必须包含模板配置 |
| OAuth 登录未指定 plan | 凭证默认 coding-plan，但用户可能需要 start-plan | 必须传 `--plan=` 参数 |
| 导入 ZCode 不区分 plan | 只读 coding-plan key，start-plan 用户导入失败 | 传 `--plan=start-plan`，导入函数会读取对应 key |
| 旧凭证无 plan 字段 | 启动时 plan 为 undefined | 自动回退 config.yaml 的全局 plan，兼容无需处理 |
| exe 超过 50MB | GitHub 推送时警告 | 可以忽略（仅警告不拒绝），或使用 Git LFS；zip 压缩后约 38MB 不会有问题 |
| **无脑复用脚本不检查 CLI 变更** | 脚本里的命令与实际 CLI 不匹配，用户运行报错 | **每次发版必须执行 Section 4 脚本变更检测** |
| **重新生成脚本但没提交到仓库** | 下次发版又得重写一遍 | Section 4.3.3 必须提交脚本更新到仓库 |

---

## 11. Plan 系统说明

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
