# 代码分类与维护指南

本轮基于性能优化提交 `160a49e` 整理账户存储、代理池和请求处理。各模块按职责分类，原有公开入口继续通过重新导出提供兼容调用。既有的增量 SSE 分帧、代理索引、统计 LRU 和请求体限制继续使用。

## 从哪里修改

| 维护任务 | 文件 | 职责 |
| --- | --- | --- |
| 凭据落盘、缓存、旧文件迁移、多账号读写 | `src/auth/store.ts` | 统一持有缓存、跨进程文件锁和读改写事务 |
| 凭据加密、旧密钥/旧密文兼容 | `src/auth/store-crypto.ts` | 新写入使用固定密钥；读取兼容历史格式和显式恢复种子 |
| 导入账户和凭据的数据清洗 | `src/auth/store-normalization.ts` | ID、默认标签、凭据字段、启用账户选择和数据复制 |
| 账户列表展示、API Key 掩码、统计标识 | `src/auth/account-view.ts` | 生成展示字段，不访问存储文件 |
| 存储和展示数据类型 | `src/auth/store-types.ts` | 区分完整凭据、存储信封和展示摘要 |
| 出口代理协议与地址校验 | `src/utils/proxy-url.ts` | 共用协议清单与 metadata/link-local/unspecified 地址规则 |
| 代理池导入、刷新、持久化、粘性状态 | `src/proxy/proxy-pool.ts` | 管理共享缓存、文件写锁、失败计数和刷新调度 |
| 代理文本/来源 URL 解析、稳定代理 ID | `src/proxy/pool-format.ts` | 无网络请求、无池状态的格式处理 |
| 池配置补丁、磁盘数据规范化 | `src/proxy/pool-normalization.ts` | 统一默认值、上限、无效输入回退和数据清洗 |
| 代理索引、冷却判断、选取 | `src/proxy/pool-selection.ts` | 维护上一轮的索引和单次扫描选择逻辑 |
| 来源下载字节限制与并发 | `src/proxy/pool-source.ts` | 有界读取、下载并发和错误长度限制 |
| 后台代理测试、取消、增量轮询、结果过期 | `src/proxy/pool-test-jobs.ts` | 一个控制器拥有一套任务状态；通过回调读池和删除失败快照 |
| HTTP 请求流程、认证、验证码、重试和账户轮换 | `src/proxy/handler.ts` | 组织请求生命周期，调用各职责模块 |
| 上游传输、连接重试、解压标签处理 | `src/proxy/upstream-dispatch.ts` | 普通/有序传输选择，连接失败重试和 Node fetch 兼容 |
| 客户端响应、转发头、gzip 和批量转换 | `src/proxy/response-builder.ts` | 构造响应并返回 token 数，由调用方记录日志 |
| 请求 ID、日志格式、脱敏和统计上报 | `src/proxy/request-log.ts` | 按请求绑定上下文，使用具名结果字段 |
| 公共 JSON 错误响应 | `src/proxy/translated-response.ts` | 保持原有轻量错误响应入口 |
| 串行状态更新与文件工具 | `src/utils/serial.ts`、`src/utils/fs.ts` | mutex 复用同一串行队列；文件工具负责原子替换 |
| 管理配置保存与待重启监听地址 | `src/admin/config.ts` | `withConfigUpdate` 串行执行合并、落盘与热更新；保留已保存地址 |
| 活跃账户与运行认证、计划同步 | `src/admin/account-actions.ts` | 共用凭证同步与配置保存队列，处理账户存储结果 |
| 系统提示词默认值、匹配、最近请求对照 | `src/config/prompt-rewrite.ts`、`src/proxy/prompt-rewrite.ts`、`src/proxy/prompt-observation.ts` | 校验规则、改写系统文本、保存有界内存快照 |

## 状态与依赖规则

- `auth/store.ts` 统一负责账户存储事务。加密、规范化、展示模块不反向导入存储入口，避免再形成缓存或锁的副本。
- `proxy/proxy-pool.ts` 统一负责代理池文件与共享选取状态。配置和格式模块只处理数据；后台测试通过 `loadProxies`、`removeFailedProxies` 回调访问池，不反向导入入口。
- `poolMutex` 保护池文件读改写，`stateMutex` 保护粘性选取和内存失败计数。缓存已加载时失败计数延迟落盘；首次未缓存失败会在持有状态锁时获取文件锁。持有文件锁的路径不得再获取状态锁。
- 后台测试控制器独立持有启动互斥锁、AbortController、结果顺序索引和清理定时器。自动删除使用测试时的代理快照，由池模块核对 ID、URL 和加入时间，保护测试期间重新导入的条目。
- 复用传输时直接导入 `upstream-dispatch.ts`，例如 Responses 处理器的连接重试。展示与 URL 校验直接导入各自模块，减少对主入口的依赖。
- 调用 `sendUpstreamRequest` 和请求日志时使用具名字段，避免位置参数混淆。日志与转储共享敏感请求头清单。
- 连接重试通过 `utils/sleep.ts` 使用宿主计时器，避免验证码窗口销毁时取消重试等待。
- 修改管理配置时，先读取并校验请求体，再调用 `withConfigUpdate`，在其回调内根据最新草稿合并并 `await save(draft)`，保存成功后热更新指定字段。不要在该回调中再调用 `persistConfig`，以免重复获取同一锁。账户存储已经提交的计划同步由 `synchronizeAccountConfig` 处理。

## 本轮精简与修正

| 核心文件 | 上一轮提交 | 本轮 |
| --- | ---: | ---: |
| `src/auth/store.ts` | 2075 行 | 1359 行 |
| `src/proxy/proxy-pool.ts` | 1780 行 | 1090 行 |
| `src/proxy/handler.ts` | 1355 行 | 871 行 |

行数减少来自职责迁移、重复逻辑合并和旧注释整理；这不是运行速度指标。

- 账户可选文本字段统一执行修剪和清空，账户更新统一复用存储保护，清理凭据统一重置缓存和写入保护。
- 地址风险判断与代理协议清单统一；保留本地/内网代理支持，校验不执行 DNS 查询。
- 请求处理只保留当前 Anthropic 上游流程，删除始终不可达的 OpenAI 上游反向转换分支。
- 修正与实际行为相反的转换/透传注释、代理池锁说明和账户 ID 长度说明。
- 修复旧测试任务延迟结束时清除新任务结果清理定时器的竞态，新增控制器隔离、失败快照删除回调、旧任务结束与新任务过期的回归测试。
- 启用 TypeScript `noUnusedLocals` 和 `noUnusedParameters`，清理全项目检查发现的闲置导入、私有参数和测试辅助函数。补齐已有异步取消测试中“没有调用 fetch”和“取消上游”的断言。

## 验证与开发

```bash
bun run typecheck
bun run test:offline
bun run build:linux-x64
bun run build:android-bundle
```

`test:offline` 使用本地网络保护，单元测试注入 mock 或回环地址服务器。CI 执行同一类型检查和离线测试命令；类型检查同时阻止闲置导入和变量重新累积。未新增第三方运行时依赖。

回归重点包括旧凭据解密/迁移、不可读文件保护、并发账户写入、代理刷新与失败落盘、测试任务取消/过期、压缩请求与响应、日志脱敏、验证码重试、SSE 和 Responses。

2026-10-07 本轮实际验证结果：

- Bun 1.4.0 全量离线测试 **1628 通过、0 失败**，90 个测试文件，5970 次断言。
- TypeScript 5.9.3 类型检查通过，包括新增的未使用代码检查。
- Linux 可执行文件与 Android 使用的 Node bundle 均构建成功，`--version` 均输出 `4.7.8-fork.1`。
- 两种运行产物对本地模拟上游均通过健康检查、模型列表、批量转换与 gzip、自动解压透传、CRLF 中文/表情 SSE、请求体超限 413 和损坏 gzip 400 验证。
- 与 `160a49e` 的运行时公开导出核对一致：账户存储 23 个、请求处理 10 个、代理池 31 个、后台入口 23 个。30 个抽出的辅助函数完成可执行函数体对比，仅允许本轮明确的命名替换。
- 源码运行时依赖图对比未发现新增循环；已有循环保持 1 个。

上一轮性能数据及验证记录见 [性能与可维护性优化记录](performance-maintainability-review.md)。
