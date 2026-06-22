# Release 构建与发布指令

> 供 Agent 参考的完整构建流程。每次发版前务必按此文档执行。
>
> **重要**：`start.bat` / `start.sh` 已纳入仓库 `release/` 目录，不再每次重写。
> 仅 `zcode-proxy.exe`（编译产物）和 `config.yaml`（从模板复制）需要每次构建时生成。

---

## 0. 前置准备

```bash
cd /home/z/my-project/lealll
# 确保仓库已拉取最新代码
git pull
```

确认 `release/` 目录已包含：
- `start.bat`  — Windows 启动脚本（仓库内，ASCII + CRLF）
- `start.sh`   — Linux/macOS 启动脚本（仓库内，可执行）
- `README.md`  — 使用说明（仓库内，每次发版时更新版本号）

如果以上文件缺失，从 git 历史恢复即可：`git checkout main -- release/`。

---

## 1. 更新版本号

三处版本号必须同步：

```bash
VERSION="2.1.3.5"   # 替换为当前版本

# package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json

# src/index.ts (VERSION 常量)
sed -i "s/const VERSION = \".*\"/const VERSION = \"$VERSION\"/" src/index.ts

# release/README.md (顶部版本说明，手动更新改进列表)

# src/admin/dashboard.html.txt (侧栏版本号)
sed -i "s|<span>v2\.[0-9.]*</span>|<span>v$VERSION</span>|" src/admin/dashboard.html.txt
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

## 4. 准备 release 目录文件

目录结构（仓库已含 start.bat / start.sh / README.md，编译后只需补两个文件）：
```
release/
├── zcode-proxy.exe    ← 上一步编译的
├── config.yaml        ← 从 config.example.yaml 复制
├── start.bat          ← 仓库内（不要重写）
├── start.sh           ← 仓库内（不要重写）
└── README.md          ← 仓库内（每次发版手动更新版本说明）
```

### 4.1 config.yaml

```bash
cp config.example.yaml release/config.yaml
```

### 4.2 验证 start.bat / start.sh 格式

每次发版前快速验证仓库里的脚本格式没有损坏（理论上不会，但防御性检查）：

```bash
# start.bat 必须是 ASCII + CRLF
file release/start.bat
# 期望: DOS batch file, ASCII text, with CRLF line terminators

# start.sh 必须可执行
[ -x release/start.sh ] && echo "OK" || chmod +x release/start.sh
```

如果 start.bat 不是 CRLF（被编辑器改坏了）：
```bash
sed -i 's/$/\r/' release/start.bat
```

如果 start.bat 含中文，请从 git 历史恢复：
```bash
git checkout main -- release/start.bat
```

---

## 5. 打包 zip

版本号从 `package.json` 读取：

```bash
cd /home/z/my-project/lealll
VERSION=$(node -p "require('./package.json').version")

cd release
zip -9 ../zcode-proxy-v${VERSION}.zip zcode-proxy.exe config.yaml start.bat start.sh README.md
cd ..
```

---

## 6. 推送代码到 GitHub

```bash
cd /home/z/my-project/lealll

# zip 不应提交到仓库（确保 .gitignore 包含 *.zip）
git status   # 确认 zcode-proxy.exe / config.yaml / *.zip 都不在待提交列表

git add -A
git commit -m "release: v${VERSION}"
git push https://{用户名}:{token}@github.com/zhu748/lealll.git main
```

---

## 7. 创建 GitHub Release 并上传

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

### 7.1 如果已有同版本 Release（重新发版）

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

# 然后再上传新的（用上面 RELEASE_ID，从 RELEASE_ID=$(...) 那行重新获取）
```

### 7.2 如果需要更新已有 Release 的描述

```bash
curl -s -X PATCH \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/$REPO/releases/$RELEASE_ID \
  -d "$(jq -n --arg body "$(cat /tmp/release-body.md)" '{body: $body}')"
```

---

## 8. 清理 token

推送/上传完成后，立即从 remote URL 中移除 token，并提醒用户去 GitHub 删除 token：

```bash
git remote set-url origin "https://github.com/zhu748/lealll.git"
```

> ⚠️ **安全提示**：每次发版用的临时 token，发版完成后必须立刻去 https://github.com/settings/tokens 删除。

---

## 9. 踩坑清单

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
| 误把 start.bat / start.sh 当成每次重写 | release.md 旧版本让 Agent 每次重新生成脚本 | 现在脚本已在仓库内，仅格式校验，不要重写 |

---

## 10. Plan 系统说明

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
