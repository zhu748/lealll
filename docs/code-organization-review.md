# 管理后台代码精简与分类记录

本轮将后台的配置、账号、OAuth、额度、日志、统计与代理池实现拆分到独立模块，保留原有公开入口，并合并重复的代理探测、目标解析、配置对象校验及凭证同步逻辑。

工作基线为 `457776873c1e483795bdfedab3c154b297d9fcc7`，整理分支为 `refactor/code-organization`。执行环境已重建，上一轮未提交工作区没有恢复，远端也没有那些修改。整理阶段生成的独立补丁只修改此前未改动的 `src/admin/api.ts`、新增后台模块、回归测试和本报告，可以叠加到保留了上一轮功能的项目上。验证结果对应上述远端基线加本轮改动，无法替代对上一轮完整项目的回归验证。`v4.7.7-fork.1` 的发布准备补充修改见下文。

**结构变化**

| 指标 | 调整前 | 调整后 |
| --- | ---: | ---: |
| 公开入口 `src/admin/api.ts` | 4,044 行 | 32 行 |
| 本轮后台模块的最大文件 | 4,044 行 | 525 行 |
| 生产代码物理总行数（原 api.ts 与其拆分模块） | 4044 | 4105 |
| 非空行总数（相同口径，含注释） | 3848 | 3835 |
| 公开导出名称（含 AdminOptions 类型） | 24 | 24 |
| API 路径与方法组合 | 50 | 50 |

模块化新增了独立的导入、导出、类型和文件间隔，总物理行数增加 61 行。具体精简发生在重复逻辑、历史说明和路由调用链上；每个模块的职责与依赖变得更明确。

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| [`account-actions.ts`](../src/admin/account-actions.ts) | 49 | 账号操作结果处理和活动凭证同步 |
| [`api.ts`](../src/admin/api.ts) | 32 | 对外导出兼容层，保持现有调用路径 |
| [`config.ts`](../src/admin/config.ts) | 481 | 配置对象检查、归一化、校验、脱敏和原子写入 |
| [`debug-dumps.ts`](../src/admin/debug-dumps.ts) | 104 | 有界诊断记录、截断、查询与清理 |
| [`http-utils.ts`](../src/admin/http-utils.ts) | 16 | 查询上限解析与错误文本长度控制 |
| [`log-file.ts`](../src/admin/log-file.ts) | 236 | 异步文件缓冲、轮转、路径切换和退出刷新 |
| [`logs.ts`](../src/admin/logs.ts) | 434 | 日志环形缓冲、序号、SSE 重放、批量推送和背压 |
| [`oauth.ts`](../src/admin/oauth.ts) | 241 | OAuth 流注册、过期清理、初始化及状态轮询 |
| [`proxy-check.ts`](../src/admin/proxy-check.ts) | 58 | 统一 HEAD 连通性探测、目标解析和超时清理 |
| [`quota.ts`](../src/admin/quota.ts) | 318 | 账号额度缓存、失效代次、请求合并和激活探测 |
| [`router.ts`](../src/admin/router.ts) | 183 | 页面、鉴权、CSRF、安全响应头及按功能分派 |
| [`routes/accounts.ts`](../src/admin/routes/accounts.ts) | 525 | 账号列表、切换、编辑、禁用、导入导出和代理设置 |
| [`routes/config.ts`](../src/admin/routes/config.ts) | 270 | 配置 GET/PUT、局部合并、热更新与重启提示 |
| [`routes/credentials.ts`](../src/admin/routes/credentials.ts) | 201 | 凭证增删查与 ZCode 读取、检测、导入 |
| [`routes/provider-settings.ts`](../src/admin/routes/provider-settings.ts) | 202 | 供应商端点、模型映射、路由规则和 thinking 设置 |
| [`routes/proxy-pool.ts`](../src/admin/routes/proxy-pool.ts) | 298 | 代理池配置、导入、刷新、删除与测试任务 |
| [`stats.ts`](../src/admin/stats.ts) | 419 | 请求去重、重试重分类、统计容量限制及统计接口 |
| [`types.ts`](../src/admin/types.ts) | 38 | 后台选项、请求上下文和路由处理器类型 |

原有 `request-body.ts` 继续管理请求体大小及读取超时，`security.ts` 继续管理安全头、验证失败限流、客户端 IP 和跨站请求检查。

**已经合并的重复逻辑**

1. 账号代理测试和代理池单项测试共用 `checkProxyConnectivity()`，保留 HEAD、重定向、10 秒超时、宿主定时器、响应体释放和错误文本截断。
2. 账号代理测试、代理池单项测试、代理池批量测试共用 `proxyTestTarget()`。目标仍采用配置供应商端点的协议与主机，URL 解析失败时保留原有默认地址。
3. 账号删除、禁用切换、账号导入和 OAuth 模式配置更新共用 `synchronizeActiveCredential()`。这些路径在没有活动凭证时继续清空内存凭证；原来仅更新已有凭证的路径保留其条件。
4. 普通配置对象和嵌套供应商对象共用一个校验函数，错误信息仍使用完整字段名，例如 `providers.zai`。
5. 路由通过功能名称直接定位处理器，URL 只解析一次。`POST /accounts/quota` 单独进入额度模块；其他方法继续遵守通用账号路由规则。
6. 统计、诊断记录和实时日志读取使用同步处理器，保留公开 `handleAdminRoute()` 的异步接口。后台生产模块检查未发现未使用的导入、局部变量或参数。
7. 文件日志与 SSE 日志各自管理状态；文件写入继续捕获每条日志当时的目标路径，避免切换文件时混写。
8. 精简过时的版本历史注释，保留重试去重、缓存失效、SSE 注册竞争窗口、背压和安全边界的说明。

**保持的边界和行为**

- 所有 API 请求先经过统一安全入口，功能处理器处理已完成鉴权的上下文。
- 验证端点保留独立的错误令牌限流；未配置令牌时继续使用回环地址限制。
- SSE 令牌查询参数、批量日志过滤、重放上限、连接寿命与清理规则保持一致。
- 统计、OAuth 流、额度缓存和日志缓冲各只有一份模块状态；旧入口重导出同一实现。
- 配置保留局部合并、脱敏占位符保护、原子写入和热更新规则。
- 凭证存储的成功、账号不存在、临时不可读三种结果保留对应响应。
- 原有后台 HTML 以及服务器、翻译器、TUI、Android、认证与代理模块的源文件没有被本轮补丁替换。

**整理阶段验证结果**

| 检查 | 结果 |
| --- | --- |
| 拆分前后台测试 | 245 项通过，3 个文件 |
| 新增路由回归检查 | 6 项，覆盖全部 50 组路径与方法的令牌、回环地址和跨站限制，以及页面、未知路由和额度路径的 DELETE 行为 |
| 最终全项目测试 | 1,464 项通过，0 失败，76 个测试文件，5,268 次断言 |
| TypeScript 5.9.3 全项目类型检查 | `tsc --noEmit` 通过 |
| 后台生产模块未使用符号检查 | `noUnusedLocals` / `noUnusedParameters` 无问题 |
| 公开导出和 API 合约比较 | 24 个名称、50 组路径与方法均一致 |
| 后台静态运行时依赖图 | 没有循环依赖 |
| Linux x64 可执行文件 | Bun 1.4.0 编译通过 |
| Android Node 服务包 | esbuild 打包通过 |

全项目验证使用 `TZ=UTC` 和阻止外网请求的预加载保护。原始 SOCKS 测试依赖外部 HTTPS 地址，验证在独立副本中将目标替换为本地 TLS 服务，继续实际测试 TCP、SOCKS、CONNECT 和 TLS 链路。仓库内原始 SOCKS 测试没有修改，本轮补丁也不含临时证书或验证副本。最终副本的后台源文件与工作树一致。

首次全项目运行在系统 `America/Cuiaba` 时区失败了一项 TUI 日期断言。原始远端基线独立运行也有相同失败；统一为 UTC 后原始基线的 34 项 TUI 测试全部通过。测试期望固定时间戳显示 `01-01`，系统时区会把它换算成前一天。本轮保留现有 TUI 日期显示行为。

整理阶段没有执行 Android APK 构建或线上部署；发布构建由 `release.md` 指定的 GitHub Actions 流程执行。

**发布准备补充（v4.7.7-fork.1）**

- `src/version.ts` 改为导入 `package.json`，CLI、后台页面和编译产物共享版本来源；Android versionCode 从 40706 递增到 40707。
- TypeScript 5.9.3 纳入开发依赖和 Bun 锁文件，类型检查通过本地工具执行，避免发布时临时下载未固定版本的检查器。
- 将 SOCKS 测试的本地 TLS 验证方式正式纳入仓库，测试证书和私钥仅供回环服务使用。客户端只信任该测试证书，继续检查 TLS 证书和主机名；无需公网，也无需修改生产代理逻辑。
- 在实际发布工作树中执行 `bun run test`（`TZ=UTC`，使用阻止外网请求的预加载保护）：1,464 项通过、0 失败、76 个文件、5,266 次断言。冻结锁文件安装、`bun run typecheck`、`bun run build:android-bundle` 与 Node 版本冒烟全部通过。
- CLI 命令保持一致，启动脚本无需调整；`start.bat` 的 ASCII/CRLF 和 `start.sh` 的 bash 语法检查通过。发布说明增加对应标签的用户手册链接。

发布提交包含本轮后台整理和上述准备修正；平台压缩包、APK 与 Docker 构建结果以该版本 GitHub Actions 和 Release 页面为准。

**补丁使用**

在保留已有功能的仓库根目录运行：

```bash
git apply --check /path/to/lealll-code-organization.patch
git apply /path/to/lealll-code-organization.patch
```

独立补丁已在原始基线上检查并试应用，逐文件比对与整理阶段工作树一致。若本地 `api.ts` 已有其他修改，先核对冲突再合并。该独立补丁保留整理阶段状态，不包含后续发布准备修正。

**其他已识别的整理区域**

| 区域 | 基线大小 | 可继续分离的职责 |
| --- | ---: | --- |
| `auth/store.ts` | 2,075 行 | 加密与原子存储、账号操作、导入导出、代理地址校验 |
| `proxy/proxy-pool.ts` | 2,016 行 | 持久化、来源解析与受限读取、轮转状态、后台检测任务 |
| `proxy/captcha-happy.ts` | 2,602 行 | DOM 环境、网络拦截、诊断记录、解题生命周期与清理 |
| `proxy/handler.ts` | 1,459 行 | 请求准备、身份与重试选择、传输、流式响应和统计 |

这些区域记录为后续整理点；本轮集中完成后台模块拆分，以保证补丁范围明确并便于叠加到此前版本。

**保留的 API 合约**

| 路径 | 方法 |
| --- | --- |
| `/admin/api/accounts` | GET |
| `/admin/api/accounts/active` | PUT |
| `/admin/api/accounts/disabled` | PUT |
| `/admin/api/accounts/edit` | PUT |
| `/admin/api/accounts/export` | GET |
| `/admin/api/accounts/export-single` | GET |
| `/admin/api/accounts/import` | POST |
| `/admin/api/accounts/label` | PUT |
| `/admin/api/accounts/plan` | PUT |
| `/admin/api/accounts/proxy` | PUT |
| `/admin/api/accounts/proxy-test` | POST |
| `/admin/api/accounts/quota` | POST |
| `/admin/api/accounts/render-export` | GET |
| `/admin/api/accounts/{id}` | DELETE |
| `/admin/api/config` | GET, PUT |
| `/admin/api/credentials` | DELETE, GET, POST |
| `/admin/api/debug-dumps` | DELETE, GET |
| `/admin/api/endpoints` | PUT |
| `/admin/api/glm-models` | GET |
| `/admin/api/import` | POST |
| `/admin/api/import/detect` | GET |
| `/admin/api/logs` | GET |
| `/admin/api/logs/stream` | GET |
| `/admin/api/model-mappings` | GET, PUT |
| `/admin/api/oauth/callback` | POST |
| `/admin/api/oauth/init` | POST |
| `/admin/api/oauth/poll` | GET |
| `/admin/api/proxy-pool` | GET |
| `/admin/api/proxy-pool/clear` | POST |
| `/admin/api/proxy-pool/config` | PUT |
| `/admin/api/proxy-pool/import-text` | POST |
| `/admin/api/proxy-pool/import-url` | POST |
| `/admin/api/proxy-pool/proxy` | DELETE |
| `/admin/api/proxy-pool/refresh` | POST |
| `/admin/api/proxy-pool/test-all` | POST |
| `/admin/api/proxy-pool/test-cancel` | POST |
| `/admin/api/proxy-pool/test-one` | POST |
| `/admin/api/proxy-pool/test-status` | GET |
| `/admin/api/responses-thinking` | GET, PUT |
| `/admin/api/routing-rules` | GET, PUT |
| `/admin/api/stats` | DELETE, GET |
| `/admin/api/verify` | GET |

**保留的公开导出**

- `AdminOptions`
- `_activeOAuthFlowCountForTesting`
- `_flushLogFileForTesting`
- `_hasActiveOAuthFlowForTesting`
- `_logFileFlushStateForTesting`
- `_logWaiterCountForTesting`
- `_probeStartPlanActivationForTesting`
- `_quotaCacheStateForTesting`
- `_rememberActiveOAuthFlowForTesting`
- `_resetActiveOAuthFlowsForTesting`
- `_resetLogFileForTesting`
- `_resetQuotaCacheForTesting`
- `_resetStatsForTesting`
- `_setAdminBodyIdleTimeoutForTesting`
- `_setLogFileAppendForTesting`
- `_setLogStreamBackpressureLimitForTesting`
- `appendLog`
- `clearDebugDumps`
- `flushLogFileForShutdown`
- `getDashboardHTML`
- `handleAdminRoute`
- `recordDebugDump`
- `recordStat`
- `setLogFilePath`
