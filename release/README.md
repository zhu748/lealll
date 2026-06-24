# zcode-proxy 使用说明

> **vceshi0.0.6 — 输入 token 计数 + 详细日志模式 + 凭证禁用/启用 + 使用次数**
>
> 用户反馈 4 项需求全部实现：统计页只看到输出 token、日志不够详细、凭证无法禁用、看不到凭证使用次数。
>
> **1. 统计页新增「输入 Tokens」列**
> - 之前：只记录输出 token（completion_tokens / output_tokens），输入 token 完全没记录。
> - 现在：`recordStat` + `printRow` + `observeStream` 全链路增加 `inputTokens` 字段。从上游响应的 `usage.input_tokens` / `usage.prompt_tokens` / `usage.input_tokens`（Responses API）/ `message_delta.usage.input_tokens`（Anthropic SSE）解析。
> - dashboard「近期请求」表头从 `Tokens` 拆为 `输入` + `输出` 两列；「模型使用情况」表头从 `总 Tokens` 拆为 `输入 Tokens` + `输出 Tokens`。
> - 控制台日志格式也改为 `in:N out:M`。
>
> **2. 详细日志模式（简略/详细开关）**
> - 之前：正常请求完全不记录请求头和转换后 body（只在 4xx 时记录摘要）。
> - 现在：dashboard「日志配置」标签页新增「详细日志模式」开关。开启后每个请求在日志里输出：
>   - `[verbose] upstream headers: {完整请求头 JSON，auth token 已脱敏}`
>   - `[verbose] transformed body: {经项目转换后发送给 zai/bigmodel 的完整 body，截断到 2000 字符}`
> - verbose 日志行放宽到 3000 字符上限（普通日志仍 500 字符），避免 body 被截断。
> - 配置：YAML `logging.verbose: true`，环境变量 `ZCODE_PROXY_VERBOSE_LOGGING=1`，dashboard 可热切换。
> - 排查 3001 / 参数错误时建议开启。
>
> **3. 凭证禁用/启用按钮**
> - 之前：凭证只能删除，不能临时停用。
> - 现在：`Credential` 接口新增 `disabled?: boolean` 字段。dashboard 账号表每行新增「禁用/启用」按钮（橙色/绿色）。
> - 禁用后：
>   - `switchToNextCredential` 跳过此凭证（不会被自动切换选中）
>   - `switchAccount` 拒绝激活此凭证（服务端强制，dashboard 也隐藏「激活」按钮）
>   - 状态列显示「已禁用」红色徽章
>   - 名称/套餐输入框半透明显示
> - 禁用当前激活的凭证时会弹确认框（仍处理进行中请求，但不会被自动切换选中）。
> - 新端点：`PUT /admin/api/accounts/disabled` body `{id, disabled: boolean}`。
>
> **4. 凭证使用次数显示**
> - 之前：凭证没有使用统计。
> - 现在：`stats` 对象新增 `byCredential` 内存映射，key = `maskApiKey(apiKey)`，value = `{count, inputTokens, outputTokens, lastUsed}`。
> - 只统计成功请求（2xx）—— 失败请求不消耗凭证配额。
> - dashboard 账号表新增「使用」列，显示该凭证的成功请求次数，hover 显示输入/输出 token 明细。
> - 每 10 秒随 `loadStats` 自动刷新（无需手动刷新账号列表）。
> - 内存统计，重启清零（与现有 stats 一致）。
>
> 全套 460 测试通过（vceshi0.0.5 是 452），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.5 — 全面 bug 修复（dashboard 模态框/CRITICAL 凭据切换/配置深合并/校验补全）**
>
> 对 dashboard、admin API、handler、store 进行全面审查后修复 22 个 bug，包括 4 个 CRITICAL、6 个 P1、12 个 P2。所有修复都有回归测试覆盖（452 测试通过，TypeScript 零错误）。
>
> **CRITICAL 修复：**
>
> **C1. dashboard 账号详情/编辑模态框无法显示（CSS 完全缺失）**
> - 现象：点「查看」「编辑」按钮看起来什么都没发生（实际 HTML 被追加到页面底部，需滚动才能看到）
> - 根因：`openAccountDetail` / `openEditModal` 用 `class="modal-overlay"` 等类名，但 CSS 里完全没定义这些类
> - 修复：在 `:root` 后添加完整 `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body` / `.modal-footer` / `.modal-close` CSS（带 fadeIn 动画、遮罩、居中、暗色背景）
>
> **C2. empty-stream 凭据切换 off-by-one（默认配置永不触发）**
> - 现象：用户配置 `maxRetries=3, emptyStreamSwitchThreshold=3`，初始响应非空 529 时，切换永远不会触发（计数器在最后一次 retry 末尾才到 3，但 break 先触发）
> - 修复：在 retry loop 末尾、break 之前加切换检查。达到阈值且有备用凭据时，授予 1 个 extra attempt 并 `continue`，让新凭据真正被尝试
>
> **C3. 凭据切换后不同步 plan（跨 plan 切换必失败）**
> - 现象：从 coding-plan 凭据切到 start-plan 凭据时，请求仍发到 coding-plan endpoint 但带 start-plan JWT → 上游 401/403
> - 修复：引入 `currentPlan` 变量，切换后调用 `effectivePlanForCred(newCred)` 更新；所有 `config.plan` 引用（buildUpstreamReq / refreshCaptchaHeaders / 401/403 检测 / transformRequestBodyObj）改为读 `currentPlan`
>
> **C4. PUT /config 浅合并 retry 对象（部分更新导致 TypeError 崩溃）**
> - 现象：客户端发 `{"retry":{"maxRetries":5}}` 会让 `retryableStatuses` 等字段丢失，handler.ts 抛 `TypeError: Cannot read property 'includes' of undefined`
> - 修复：对 `retry` / `identity` / `logging` / `providers` 都做深合并（之前只 `auth` 做了）
>
> **P1 修复：**
>
> - **statTotal ID 重复**：账号页「账号总数」卡片 10 秒后被统计页「总请求数」覆盖。改账号页 ID 为 `statAccountsTotal`
> - **btn-warning CSS 未定义**：「导出 Render 凭证」按钮无警告色。加 `.btn-warning` 别名
> - **clearCredentials 不检查 r.ok**：服务端返回 4xx 时仍显示「凭证已清空」成功提示。改为检查 `r.ok`
> - **loadDebugDumps upstreamError.slice 空值崩溃**：`upstreamError` 为 undefined 时 `.slice()` 抛 TypeError，整个 dumps 列表渲染失败。加 `||''` 保护
> - **/admin/api/endpoints 不持久化**：修改 endpoints 重启即丢失。加 `persistConfig` 调用
> - **POST /admin/api/credentials 缺热替换+校验**：手动添加 API Key 在 oauth 模式下不立即生效；空 apiKey / 未知 provider 写入脏数据。加字段校验 + invalidateStoreCache + setOAuthCredential 热替换
> - **POST /admin/api/import 缺热替换**：从 ZCode 导入在 oauth 模式下不立即生效。加热替换 + name 自动命名为 `zcode(N)-plan`
> - **bigmodel 手动 callback 缺 state 校验**：CSRF 防御不一致（zai 有 bigmodel 无）。补齐 `state !== flow.state` 校验
> - **/admin/api/oauth/poll 不检查过期**：过期 flow 永远返回 "pending"，dashboard 永远转圈。加过期检查返回 `"expired"` 状态；失败时返回 `error` 字段
>
> **P2 修复：**
>
> - 未定义 CSS 变量 `--bg-1/--bg-2/--text-1/--text-0/--warning/--warning-bg` 全部添加别名映射
> - Escape 键现在能关闭账号详情/编辑模态框（之前只关 proxy/quota 模态框）
> - `loadUptimeFromServer` 登出后停止请求（之前每秒发 401）
> - `openAccountDetail` 的 API Key 行在 `cred.apiKey` 为空时不再显示 `[object Object]`
> - `validateConfigForSave` 增加 `emptyStreamSwitchThreshold`（>=0）和 `backoffFactor`（>0）校验
> - `PUT /admin/api/accounts/edit` 增加 name/email 类型校验（防非字符串值崩溃 setAccountName 的 .trim()）
> - `GET /admin/api/accounts/export-single` 加 `invalidateStoreCache`（外部新增账号立即可见）
> - `undecryptableFilePresent` 守卫在解密成功 / 文件不存在时自动清除（之前用户用 LEGACY_SEED 恢复后能读不能写，被锁死）
>
> 全套 452 测试通过（vceshi0.0.4 是 445），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.4 — 空回阈值可配置 + 凭证名称/邮箱 + 单账号导出（测试版）**
>
> 用户反馈：3 次空回切换凭证的阈值应该可配置；凭证 JSON 格式应该有 name + email；账号管理 UI 应该可以查看/编辑/导出单账号。本版全部实现。
>
> **1. 空回切换阈值可在面板配置**
> - 之前：硬编码 3 次，用户无法调整。
> - 现在：dashboard「重试配置」标签页新增「空回切换阈值」输入框（默认 3，设为 0 禁用回退到普通凭证切换阈值）。YAML 配置 `retry.emptyStreamSwitchThreshold`，环境变量 `ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD`。
>
> **2. 凭证 JSON 格式增加 name + email 字段**
> - OAuth 登录：自动从回调响应的 `data.user.email` 提取邮箱，名称自动命名为 `邮箱-套餐`（如 `alice@x.com-start-plan`）。
> - ZCode 导入：邮箱为空，名称自动命名为 `zcode(N)-套餐`（N = 当前已导入的 zcode 账号数 + 1，如 `zcode(1)-coding-plan`）。
> - 手动添加 API Key：name 和 email 都为空，dashboard 显示自动生成的标签作 fallback。
> - dashboard「账号管理」表头从「标签」改为「名称」，按凭证创建时间正序排（最旧的排最前），无 name 时回退到自动 label。
>
> **3. 账号管理每行新增 查看/编辑/导出 按钮**
> - **查看**：模态框显示完整凭证信息（含 API Key/Secret/JWT 的「显示/隐藏」切换）。
> - **编辑**：模态框可改 name + email（保存即生效，热替换内存凭证）。
> - **导出**：浏览器下载该账号的完整 JSON 凭证文件，文件名 = 名称或标签，含完整 apiKey/secret/jwt/email/name — 可用于备份或迁移到其他机器。
>
> **4. 新增环境变量**
> - `ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD` — 空回切换阈值，默认 3
>
> 全套 445 测试通过（vceshi0.0.3 是 430），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.3 — 凭证加密根因修复 + 空回重试 + Dashboard 优化（测试版）**
>
> 一次性修复 vceshi0.0.2 暴露的 6 个用户痛点 + UI 优化。所有改动都有回归测试覆盖（430 测试通过，TypeScript 类型检查零错误）。
>
> **0. 加密解密根因修复（最关键 — 解决"版本更新后凭证丢失"的根本原因）**
>
> - **现象**：用户报告「同一个 zip 解压两次能用，但新版本 release 解压后凭证全没」。只能提前导出账号再更新。
> - **根因深挖**（不是简单的"加密失败"）：
>   - 旧版密钥派生用 `SHA-256(${homedir()}-${process.platform}-${process.arch})`
>   - 旧 release 用 Bun 1.1 编译 → `os.homedir()` 在 Windows 直接读 `USERPROFILE` 环境变量
>   - 新 release（GitHub Actions）用 Bun 1.3.14 编译 → `os.homedir()` 改用 Win32 API `SHGetKnownFolderPath`，返回值可能在大小写、路径规范化、域用户后缀（`Alice` vs `Alice.Company`）等方面不同
>   - git 历史可证：`4ca5f0e` "fix(docker): upgrade bun base image to 1.2" + `ffe3075` "add GitHub Actions build" — Bun 1.1 → 1.2 → 1.3 的升级链改变了 `homedir()` 行为
>   - 结果：旧 `credentials.json` 用 X 加密，新二进制算出 Y，解密失败 → 旧版"备份+返回 null"逻辑让 `saveCredential` 静默覆盖原文件 → 凭证全没
> - **修复（三层防御）**：
>   1. **持久化 key file**（`~/.zcode-proxy/.secret-key`）：首次运行时把派生出的 key 写入文件，之后所有运行都直接读文件，**不再依赖 `homedir()`/`platform`/`arch`** — 这些变量再怎么变都不影响。Bun 升级、Windows 用户名改、跨位数编译全部免疫。
>   2. **多 seed fallback**：解密失败时自动尝试所有合理的旧 seed 组合：
>      - `${homedir()}-${plat}-${arch}` / `${homedir()}-${plat}` / `${homedir()}-${arch}` / `${homedir()}`
>      - `${USERPROFILE}-*` / `${HOMEDRIVE}${HOMEPATH}-*` / `${HOME}-*`（旧 Bun 直接用这些 env var）
>      - 每种 seed 都试 SHA-256 派生 + XOR-fold 派生（覆盖 zcode-api-ref 旧格式）
>      - 每种 key 都试 Node crypto 格式（IV[16]）+ WebCrypto 格式（IV[12]）
>      - 任意一个组合成功 → 解密成功 + 把命中的 key 写入 key file，下次免 fallback
>   3. **手动恢复通道**：`ZCODE_PROXY_LEGACY_SEED` 环境变量让用户显式提供旧 seed 字符串（例如 `set ZCODE_PROXY_LEGACY_SEED=C:\Users\OldName-win32-x64`），多 seed fallback 会尝试它
> - **效果**：用户更新到 vceshi0.0.3 后：
>   - 首次启动 → 多 seed fallback 自动找到旧 key → 解密成功 → key 持久化到 key file
>   - 之后所有运行 → 直接读 key file → 再也不依赖 homedir/platform/arch → 任何版本更新都不再丢凭证
> - **极端情况兜底**：如果所有 fallback 都失败（如 credentials.json 从完全不同的机器拷过来），上一版的"拒绝覆盖"守卫仍生效——不会静默销毁原文件，用户可手动恢复或显式 `auth logout` 重来
>
> **1. 版本更新后凭证丢失（严重数据丢失 bug）**
> - **现象**：下载新 release 解压后启动 exe，提示「没有凭证」无法进入；回到 `~/.zcode-proxy/` 发现 `credentials.json` 被清空。
> - **根因**：上面 #0 详解。
> - **修复**：
>   - 上面 #0 的三层防御从源头解决
>   - 额外兜底：`src/auth/store.ts` 新增 `undecryptableFilePresent` 守卫标志。一旦读到无法解密的 `credentials.json`，`writeStore()` 会**抛错拒绝覆盖**，强制 `saveCredential` 把错误冒泡给调用方。原文件保持不变，`.broken-{timestamp}` 备份也保留。
>   - 用户必须显式执行 `zcode-proxy auth logout`（或 dashboard 的「清空凭证」按钮）才会清除守卫，之后才能保存新凭证——避免任何意外的数据销毁。
>   - `clearCredential()` 同时清除守卫标志 + 删除 key file，确保登出后能正常重新登录。
>
> **2. Dashboard 刷新看不到外部新增凭证**
> - **现象**：通过 `start.bat` 获取新凭证后，刷新 dashboard 看不到，必须重启程序。
> - **根因**：`store.ts` 的 `cachedStore` 是进程内缓存，`writeStore` 才失效。外部进程（start.bat 调起的 `zcode-proxy auth login`）写入磁盘后，长期运行的代理进程的缓存仍是旧快照。
> - **修复**：导出 `invalidateStoreCache()`，在 `/admin/api/accounts` 和 `/admin/api/credentials` 的 GET handler 中调用——dashboard 每次刷新都强制重新读盘+解密，外部进程的新增凭证立即可见。
>
> **3. 200 空回被识别为有效输出（额度耗尽时的核心 bug）**
> - **现象**：某账号额度耗尽时上游返回 HTTP 200 + `text/event-stream` 但 body 为空（无任何 SSE 事件）。代理透传给客户端，Claude Code / Codex CLI 报「empty or malformed response (HTTP 200)」，但 dashboard 统计显示成功。
> - **修复**：`src/proxy/sse-error-detector.ts` 增加 empty-stream 检测——如果 200 SSE 流读到结束都没出现任何完整 SSE 事件（`\n\n` 分隔的块），合成一个 529 `overloaded_error` 响应，并打上 `x-zcode-empty-stream: 1` 标记头。
>
> **4. 空回 3 次后自动切换凭证**
> - **现象**：用户期望「200 空回 → 重试 3 次 → 仍空回就切换下一个凭证」，但旧逻辑只在 5 次普通失败后才切换，对空回这种「凭证已死」的强信号反应太慢。
> - **修复**：`src/proxy/handler.ts` 新增 `consecutiveEmptyStreams` 计数器（与现有 `consecutiveCredFailures` 独立）。检测到 `x-zcode-empty-stream: 1` 标记就累加；达到 3 次立即调用 `auth.switchToNextCredential()`，**不等** `credentialSwitchThreshold=5`。切换时额外授予 1 次 retry 配额（`extraAttemptsFromSwitches`），确保新凭证至少有 1 次尝试机会。切换后计数器重置，新凭证走完整的 3 次空回阈值才会再次切换。
> - 日志清晰显示每次空回与切换：「`retry 2 got empty-stream 529 (3/3 before forced switch)`」「`credential switched after 3 consecutive empty-stream responses`」。
>
> **5. OAuth 新凭证默认启用，覆盖原选择**
> - **现象**：dashboard 走 OAuth 登录新账号后，新账号立即变成 active，原激活账号被静默替换——用户没点「激活」却发生切换。
> - **根因**：`saveCredential` 总是把新账号设为 active（`store.activeId = account.id`），无论调用方是否期望保持原选择。
> - **修复**：`saveCredential` 增加可选参数 `opts.keepActive`。当 `keepActive: true` 且已存在 active 账号时，新账号**仅追加**到列表，不动 `activeId`。`src/admin/api.ts` 中 4 处 OAuth 完成点（bigmodel 自动回调、zai 自动轮询、zai 手动 callback、bigmodel 手动 callback）全部传入 `{ keepActive: true }`。只有「首次登录」（store 为空）才会自动激活。用户必须显式点 dashboard 的「激活」按钮才会切换。
>
> **6. bigmodel 手动 callback 缺热替换（一致性 bug）**
> - **现象**：bigmodel 手动 callback 路径在 OAuth 完成后没有调用 `opts.auth.setOAuthCredential()`，与其他 3 处 OAuth 完成点不一致——用户在远程环境用手动 callback 登录后，运行中的代理仍用旧凭证，直到重启才生效。
> - **修复**：补齐热替换调用，与其他 3 处对齐。同时所有 OAuth 完成点统一行为：**只在首次登录（store 为空）时热替换**，否则保留当前激活——与 `keepActive` 语义一致。
>
> **7. UI 优化：账号管理排版重构**
> - 新增 4 卡片统计栏：账号总数 / Bigmodel / Z.AI / Start Plan 数量一目了然。
> - 表头增加搜索框 + 提供商/套餐过滤器：实时过滤，无网络请求。
> - 右上角「刷新」按钮：强制重新读盘，外部新增凭证立即可见（与 Bug #2 修复配合）。
> - 标题栏副标题增加可点击「刷新」链接。
> - 账号数量徽标动态显示（如「3 个」）。
> - 空状态分两种：完全无账号 vs 过滤无匹配，引导更清晰。
> - 「添加 API Key」表单帮助文案明确说明：手动添加会自动激活，OAuth 不会——与 Bug #5 行为一致。
>
> 全套 430 测试通过（vceshi0.0.2 是 422），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.2 — 凭证额度查询功能（测试版）**
>
> 新增「额度查询」：dashboard 账号表格每个账号的「操作」列新增「额度」按钮，点击后实时查询上游真实额度并弹窗展示。
>
> **功能内容**：
> - start-plan 账号：查询 zcode.z.ai 的套餐（`billing/current`）+ 余额（`billing/balance`），显示套餐名、到期时间、每个模型（如 GLM-5.2 / GLM-5-Turbo）的剩余 token 与每日重置时间
> - coding-plan 账号：查询提供商（api.z.ai / open.bigmodel.cn）的额度上限（`/api/monitor/usage/quota/limit`），显示套餐等级与各项额度明细
> - 额度接口逆向自 ZCode 客户端，每个模型额度独立展示（不混算成单一百分比，避免「某模型已用完但整体显示 40%」的误导）
> - 支持为配了出口代理的账号查询（复用该账号的 proxy 配置）
> - 新增 10 个单元测试，全套 422 测试通过，TypeScript 类型检查零错误
>
> 全套 422 测试通过，TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.1 — OAuth 凭证切换失效修复（测试版）**
>
> 修复 dashboard 通过 OAuth 登录的账号在切换后立即失效的问题。原现象：OAuth 账号切换后 Claude Code 报 `API returned an empty or malformed response (HTTP 200)`，但从 ZCode 桌面版导入的账号切换后正常工作。
>
> **根因（两个 bug 叠加）**：
> 1. **OAuth 登录完成后未热替换内存凭证**：`/admin/api/oauth/*` 三处完成点（bigmodel 自动回调、zai 自动轮询、zai 手动回调 URL）都只调用 `saveCredential(cred)` 写入磁盘，**没有**调用 `opts.auth.setOAuthCredential(cred)` 热替换 `AuthManager` 内存中的凭证。结果：OAuth 登录后 dashboard 显示新账号为 active，但请求路径仍使用旧凭证（通常是之前 zcode 导入的）。只有用户显式点击「激活」切换时，`/admin/api/accounts/active` 的 handler 才会真正热替换 —— 此时 OAuth 凭证第一次被真正使用，立刻暴露 bug #2。
> 2. **start-plan 模式下注入了 `metadata.user_id`**：`src/proxy/body-transformer.ts` 的 `applyAnthropicUserId` 没有像 `applyAnthropicCacheControl` 那样为 start-plan 做特判。OAuth 登录的凭证带 `userId` 字段（zcode 导入的不带），所以只有 OAuth 账号会触发 `metadata.user_id` 注入。ZCode start-plan 网关收到该字段后返回 `200 + content-type: text/event-stream` 但 body 为空，被 `sse-error-detector.ts` 当作合法空流透传给客户端，Claude Code 报 "empty or malformed response"。
>
> **修复内容**：
> 1. `src/admin/api.ts` 三处 OAuth 完成点均补充 `opts.auth.setOAuthCredential(activeCred)` 热替换，与 `importAccounts` 路径行为对齐
> 2. `src/proxy/body-transformer.ts:150-158` 增加 `&& !ctx.startPlan` 守卫，start-plan 模式下不注入 `metadata.user_id`（与同文件 `applyAnthropicCacheControl` 的 start-plan 特判对称）
> 3. 新增 2 个回归测试用例（start-plan 不注入 / coding-plan 仍注入），更新 1 个原有断言
>
> **影响范围**：
> - **所有 OAuth 登录用户**：切换账号后立即生效，无需重启
> - **start-plan + OAuth 用户**：不再出现 "HTTP 200 empty response" 错误
> - **coding-plan 用户**：行为不变（仍注入 `metadata.user_id`）
> - **zcode 导入用户**：行为不变（本来就没有 `userId`，本来就不注入）
>
> 全套 409 测试通过，TypeScript 类型检查零错误。
>
> ---

> **v2.1.4.1test6 — 代理配置 UI 升级：模态框 + 测试连接**
>
> 重做 v2.1.4.1test5 引入的代理配置入口：移除账号表格里的内联输入框（输入 URL 字符串体验差、容易输错），改为操作列的「代理」按钮 + 弹出式模态框，支持代理类型选择、主机/端口/账号/密码分字段填写、一键测试连通性。
>
> **v2.1.4.1test6 关键改进**：
> 1. **Dashboard UI 重做**：
>    - 移除账号表格的「代理」列，恢复 colspan 到 7
>    - 操作列新增「代理」按钮（btn-ghost 风格，与「激活」「删除」并列）
>    - 已配置代理的账号在 API Key 列显示「代理」徽标（hover 显示完整 URL）
>    - 点击「代理」按钮打开模态框，预填该账号当前代理设置
> 2. **代理模态框**：
>    - 代理类型下拉：无代理 / HTTP / HTTPS / SOCKS5 / SOCKS5h（远端 DNS）
>    - 主机（必填）、端口、用户名、密码分字段输入，免去手拼 URL
>    - 用户名密码 URL 编码自动处理（含 `@`、`:`、`/` 等特殊字符）
>    - 选「无代理」时所有字段禁用 + 清空，方便一键恢复直连
>    - 「测试连接」按钮：调用后端 proxy-test 端点，实时显示结果（成功显示 HTTP 状态码 + 延迟，失败显示错误信息）
>    - Esc 键关闭模态框，点击遮罩关闭，× 按钮关闭
> 3. **新增 `POST /admin/api/accounts/proxy-test` 端点**：
>    - 接收 `{ proxy, provider? }`，用 Bun 原生 `fetch(url, { proxy })` 对上游 base URL 发 HEAD 请求
>    - 10s 超时，超时清晰提示「Connection timed out after 10s」
>    - 任何 HTTP 响应（200/404/403 等）都视为代理可达；只有网络层错误（拒绝连接、DNS 失败、代理鉴权失败等）才返回 `ok: false`
>    - 返回 `{ ok, status?, latencyMs, target, error? }`，永远 HTTP 200 让前端能渲染错误信息
>    - `provider` 字段决定测试目标：zai→`https://api.z.ai`，bigmodel→`https://open.bigmodel.cn`
> 4. **`AdminOptions` 新增 `fetchImpl` 字段**：让测试代码可注入 mock fetch，避免真实网络调用
> 5. **Add API Key 表单**：移除「出口代理」输入字段，改为提示「添加后可在账号列表中点击「代理」按钮配置」，统一代理配置入口
> 6. **新增 8 个回归测试**（共 407 测试通过）：
>    - proxy-test API 8 个：参数校验 / scheme 校验 / 成功 / bigmodel 切换 / 4xx 视为成功 / 网络错误 / 超时
> 7. **JS 工具函数**：`buildProxyUrlFromModal()` / `parseProxyUrl()` 实现字段 ↔ URL 双向转换；用户密码用 `encodeURIComponent` 处理
>
> **影响范围**：
> - **所有使用代理功能的用户**：从拼字符串改为分字段填写，体验大幅改善
> - **添加新 API Key 流程**：先添加 Key，再点「代理」按钮配置出口，两步分离更清晰
> - **后端兼容性**：v2.1.4.1test5 的 `PUT /admin/api/accounts/proxy` 端点完全不变，存储格式不变，凭证字段不变
>
> ---

> **v2.1.4.1test5 — 账号级出口代理（per-account HTTP proxy）**
>
> 新增**账号级出口代理**功能：在 dashboard 账号管理页面，可以为每个账号单独配置 HTTP / HTTPS / SOCKS5 出口代理，让不同账号走不同的网络出口（例如让 A 账号走日本节点、B 账号直连、C 账号走 SOCKS5）。代理在请求时动态读取，多账号 retry 切换凭证时新账号的代理会自动生效。
>
> **v2.1.4.1test5 关键改进**：
> 1. **`Credential` 接口新增 `proxy?: string` 字段**：可选字段，留空 = 直连；设置 = 所有上游请求走该代理
> 2. **`fetchUpstreamDetected` 动态注入代理**：在每次上游 fetch 时读取 `cred.proxy`，通过 Bun 原生 `fetch(url, { proxy })` 选项路由请求。**关键设计**：每次调用都重新读取 `cred.proxy`，所以 retry 时凭证自动切换（key-AAA → key-BBB）会立即应用新账号的代理设置，不会缓存旧代理
> 3. **`setAccountProxy(id, proxy)` 存储函数**：持久化代理设置到加密的 `credentials.json`；空字符串清除代理，回到直连
> 4. **`PUT /admin/api/accounts/proxy` 新 API 端点**：dashboard 编辑代理的后端，支持 scheme 校验（`http(s)://` / `socks5(h)://`），更新激活账号时自动热替换内存凭证（无需重启）
> 5. **`POST /admin/api/credentials` 接受 `proxy` 字段**：手动添加 API Key 时可直接指定代理
> 6. **Dashboard UI 增强**：
>    - 账号表格新增「代理」列，每行带独立输入框，失焦即保存
>    - 添加 API Key 表单新增「出口代理」可选输入
>    - 客户端轻量 scheme 校验 + 失败时回滚输入框
>    - 表格 `colspan` 同步从 7 调整为 8
> 7. **代理设置随凭证导出**：`exportAccounts` / `exportStore` / Render 凭证导出都会带上 `proxy` 字段，云端部署时各账号的代理配置完整保留
> 8. **新增 18 个回归测试**（共 399 测试通过）：
>    - `setAccountProxy` 存储层 5 个：持久化 / 清除 / 未知 ID / 字段保留 / listAccounts 暴露
>    - `accounts/proxy` API 9 个：参数校验 / scheme 校验 / 404 / 设置 / 清除 / 热替换 / socks5 / trim
>    - 代理路由 handler 4 个：proxy 传递 / 不传 / socks5 / decompress 共存
>
> **影响范围**：
> - **多账号 + 多网络出口用户**：可以为不同账号配置不同代理，灵活组合（如某账号被风控时切到代理出口）
> - **单账号用户**：留空代理字段，行为与 v2.1.4.1test4 完全一致
> - **retry 凭证切换**：从有代理的账号切到无代理账号会自动停止使用代理，反之亦然
>
> ---

> **v2.1.4.1test4 — Docker 部署修复（bun 1.2 lockfile 兼容）**
>
> 修复 v2.1.4.1test3 在 Render / Docker 部署时的构建失败问题：`bun.lock` 使用 Bun 1.2+ 引入的新 JSON 格式（`lockfileVersion: 1`），而 Dockerfile 的 base image 仍是 `oven/bun:1.1-debian`，Bun 1.1.45 无法解析该格式，导致 `bun install --frozen-lockfile` 在容器构建阶段报 `InvalidLockfileVersion` 错误。
>
> **v2.1.4.1test4 关键修复**：
> 1. **Dockerfile base image 升级**：`oven/bun:1.1-debian` → `oven/bun:1.2-debian`，匹配 `bun.lock` 的新 JSON lockfile 格式
> 2. **同步更新 Dockerfile 注释**：说明必须使用 Bun ≥ 1.2 的原因（lockfile 格式兼容性）
> 3. **零源代码变更**：本次发版仅修复部署链路，业务逻辑与 v2.1.4.1test3 完全一致
>
> **影响范围**：
> - **Render / Docker / Fly.io / Cloud Run 用户**：解决 `bun install` 构建失败问题，部署可正常完成
> - **本地直接运行（bun run）用户**：无影响
>
> ---

> **v2.1.4.1test3 — 多账号 Render 凭证导出修复**
>
> 修复 v2.1.4.1test2 引入的 Render 凭证导出 bug：多账号场景下，dashboard "导出 Render 凭证" 只导出当前激活的一个账号，导致用户在 Render 上只能用到一个账号，丢失了多账号轮转能力。
>
> **v2.1.4.1test3 关键修复**：
> 1. **`/admin/api/accounts/render-export` 多账号修复**：原实现调用 `loadCredential()` 只取激活凭证；新版改用新增的 `exportStore()` 获取完整 v2 store（含所有账号 + activeId 指针）
> 2. **智能格式自适应**：单账号时仍输出 bare credential base64（向后兼容旧 `render-start.sh`）；多账号时输出完整的 v2 store envelope（`{version:2, activeId, accounts:[...]}`）
> 3. **`render-start.sh` 自动识别两种格式**：解码 `ZCODE_OAUTH_CREDENTIAL` 后，检测顶层是否含 `version:2 + accounts` 数组——是则直接落盘为 `credentials.json`，否则按原逻辑包装为单账号 store
> 4. **Dashboard UI 增强**：导出弹窗标题新增「单账号 / 多账号 · N 个」徽标；安全提示在多账号模式下明确警告 blob 包含所有账号的明文凭证
> 5. **新增 `exportStore()` 工具函数**：返回 v2 store 的深拷贝（含 activeId），供后端导出接口使用
> 6. **新增 3 个回归测试**：覆盖 0 账号（404）/ 1 账号（bare credential）/ 2 账号（v2 envelope）三种场景，确保两个 API key 都出现在 base64 blob 中
> 7. **测试覆盖**：全套 381 测试通过（v2.1.4.1test2 是 378），TypeScript 类型检查零错误
>
> **影响范围**：
> - **单账号用户**：无感知，行为与 v2.1.4.1test2 完全一致
> - **多账号用户**：现在能完整部署所有账号到 Render，dashboard 切换功能在云端可用
>
> ---

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
