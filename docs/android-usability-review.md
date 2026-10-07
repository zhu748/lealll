# Android APK 可用性优化

本轮主要改进启动恢复、后台服务控制、界面状态一致性和 APK 构建可靠性。沿用现有 Android applicationId、服务端凭据格式、默认本机监听和 arm64-v8a 运行时。

## 使用行为

- Android 7 的启动通知改用 NotificationCompat，避免直接调用仅 API 26 可用的通知构造方法。
- 服务在认证控制接口响应后才进入就绪状态；启动超时或 Node 子进程退出会停止服务，并保留错误及最近 40 条启动日志。主页提供重试、重启和复制诊断入口。
- 通知显示代理状态，点击可返回应用，操作按钮可停止整个后台服务。Android 13+ 首次申请通知权限，拒绝后可从设置页恢复；权限回调会立即更新界面状态。
- 前台服务类型改为符合用户主动运行的本地 API 代理用途的 specialUse，并声明用途；保留系统停止回调清理。没有永久唤醒锁，系统和厂商的后台限制仍可能影响运行。
- ViewModel 保留屏幕旋转时的状态。页面隐藏后停止状态、日志和时长刷新；命令执行期间限制重复点击，操作失败保留可关闭的提示。
- 切换登录态、服务商、套餐或控制会话时取消并使旧额度请求失效，旧结果无法覆盖当前状态。额度仍为首次获取与手动刷新，未增加上游轮询。
- 日志使用不可变快照作为缓存键，修复满 500 条后内容不更新的问题；用户向上阅读时避免强制滚动。
- OpenAI 接入复制完整 `/v1` Base URL，提示 Anthropic 接入地址；启动代理后可打开高级管理面板。无浏览器时复制授权/下载链接并显示反馈。
- 登出前说明将删除全部本地账户凭据。代理运行时仍限制登出和接入配置切换。
- 运行时长来自服务端启动时间，重新打开界面不会归零。更新比较包含 fork 序号和第四段版本号，修复漏报 fork.1 → fork.2 更新。

## 实现与构建

MainActivity 从 1684 行缩至 473 行。页面、通用组件、额度解析和 ViewModel 分文件组织；职责表与开发步骤见 [Android README](../Android-APP/README.md)。

ControlTransport 使用平台 HTTP 实现处理 UTF-8 字节长度、分块响应和 HTTP 状态，限制响应体为 1 MiB，并在取消或关闭时断开请求。状态/日志使用短超时，额度使用独立的长超时。

运行资源按 APK 安装更新时间缓存，文件通过临时文件原子替换，最后提交版本标记；中断更新或缺少资源会重试提取。配置和凭据独立保存。移除服务端已不使用的 Android Keystore 种子依赖，补上禁止云备份和设备迁移的规则。

统一 AGP 8.7.3 / Gradle 8.9 / SDK 35 / build-tools 35.0.0，wrapper 固定 SHA256。APK 脚本自动构建并复制服务包，支持本机 JDK/SDK 和 Docker，透传 Gradle 参数。默认 versionCode 按仓库主版本、次版本和补丁生成，与 release CI 一致，支持显式覆盖并拒绝无效值。

Release 启用 R8 和资源压缩，移除整包 keep 规则，保留 ViewModel 反射构造入口；Debug 保留调试代码。CI 增加 Android 测试、两种构建、lint 和控制生命周期冒烟验证。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| 服务完整离线测试 | 1628 通过、0 失败；Bun 1.4.0 |
| Android JVM 测试 | 17 通过、0 失败 |
| Android lint | Debug / Release 均 0 错误，各 4 条警告 |
| 构建 | assembleDebug / assembleRelease 通过 |
| 控制通道冒烟 | Bearer 校验、启动/停止、稳定运行时长、配置限制与切换、增量日志、管理页面、中文代理响应、退出均通过 |
| APK 签名 | v2 签名验证通过，本地测试密钥 |
| APK 元数据 | applicationId com.zcode.proxy；versionCode 40708；最低 API 24；target API 35；仅 arm64-v8a |
| 包内服务代码 | 与当前 dist/android/server.cjs 和 assets 服务包字节一致 |
| 原生库 | APK 内 12 个库的 PT_LOAD 最低对齐为 16384 字节；按现有提取方式压缩打包 |
| R8 反射入口 | mapping 验证 ViewModel 无参构造保留 |
| APK 大小 | Release 35.68 MiB；Debug 46.72 MiB |

大小比较为同一轮代码的 Release 与 Debug 构建，并非与原版本 APK 的设备性能对比。lint 警告为固定 Lifecycle 版本的新版本提示和仅提供 ARM64 的 ChromeOS ABI 提示，未为消除提示而升级整个 AndroidX 栈。

交付的压缩测试 APK SHA256：

```text
706a9acd7c962e5423e8fefd4a725671722d640aeb1635485ca71044b1589a6b
```

## 尚需设备验证

当前环境未连接 Android 真机或 ARM64 模拟器。本轮验证不代替 Android 7/13/14/15/16 设备上的冷启动、浏览器 OAuth、通知权限、熄屏后台运行、长对话、覆盖安装及 start-plan 验证。

交付 APK 使用本地测试签名，不是 GitHub 正式 release 签名。覆盖已安装正式版需要原签名证书及不低于当前安装版本的 versionCode；正式发布仍走仓库 release 流程。
