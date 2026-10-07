package com.zcode.proxy.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.RuntimePhase
import com.zcode.proxy.RuntimeSession
import com.zcode.proxy.update.UpdateChecker
import com.zcode.proxy.update.UpdateInfo
import com.zcode.proxy.ui.theme.ThemeMode
import com.zcode.proxy.ui.theme.dimColor
import com.zcode.proxy.ui.theme.successColor

@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun SettingsScreen(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    provider: String,
    plan: String,
    proxyPort: Int,
    proxyRunning: Boolean,
    reachable: Boolean,
    loggedIn: Boolean,
    currentVersion: String?,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateCheckFailed: Boolean,
    onCheckUpdate: () -> Unit,
    autoCheckUpdate: Boolean,
    onAutoCheckUpdateChange: (Boolean) -> Unit,
    notificationsEnabled: Boolean,
    onNotificationSettings: () -> Unit,
    onOpenDashboard: () -> Unit,
    runtime: RuntimeSession,
    busy: Boolean,
    onStartService: () -> Unit,
    onRestartService: () -> Unit,
    onStopService: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 120.dp),
    ) {
        Text("设置", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface, modifier = Modifier.padding(vertical = 10.dp))
        CardBlock(title = "外观") {
            Text("主题", fontSize = 13.sp, color = cs.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SegChip("跟随系统", themeMode == ThemeMode.FOLLOW_SYSTEM, true) { onThemeModeChange(ThemeMode.FOLLOW_SYSTEM) }
                SegChip("亮色", themeMode == ThemeMode.LIGHT, true) { onThemeModeChange(ThemeMode.LIGHT) }
                SegChip("暗色", themeMode == ThemeMode.DARK, true) { onThemeModeChange(ThemeMode.DARK) }
            }
            Spacer(Modifier.height(6.dp))
            Text("跟随系统时，深色模式开关即时生效", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "接入信息") {
            SettingRow("服务商", if (provider == "zai") "Z.AI" else "智谱")
            SettingRow("套餐", plan)
            SettingRow(
                "状态",
                when {
                    proxyRunning -> "127.0.0.1:$proxyPort · 运行中"
                    reachable -> "未启动"
                    else -> "本地服务未连接"
                },
                valueColor = if (proxyRunning) successColor() else cs.onSurface,
            )
            SettingRow("登录", if (loggedIn) "已登录" else "未登录")
            Spacer(Modifier.height(4.dp))
            Text("切换服务商/套餐在主页「接入配置」卡", fontSize = 12.sp, color = dimColor())
            TextButton(onClick = onOpenDashboard, enabled = proxyRunning && reachable) { Text("打开高级管理面板") }
            Text("启动代理后，可在管理面板查看账户、统计和详细配置。", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "后台运行") {
            SettingRow("服务", when (runtime.phase) {
                RuntimePhase.READY -> "已就绪"
                RuntimePhase.STARTING -> "启动中…"
                RuntimePhase.STOPPING -> "停止中…"
                RuntimePhase.STOPPED -> "已停止"
                RuntimePhase.FAILED -> "异常，请回主页查看诊断"
            })
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (runtime.phase == RuntimePhase.READY) {
                    TextButton(onClick = onRestartService, enabled = !busy) { Text("重启服务") }
                    TextButton(onClick = onStopService, enabled = !busy) { Text("停止服务") }
                } else {
                    TextButton(onClick = onStartService, enabled = runtime.phase == RuntimePhase.STOPPED || runtime.phase == RuntimePhase.FAILED) { Text("启动服务") }
                }
            }
            Text("停止服务会关闭代理；重启会重新加载配置，登录凭据会保留。", fontSize = 12.sp, color = dimColor())
            SettingRow("通知", if (notificationsEnabled) "已允许" else "未允许")
            Text("通知可查看运行状态，并直接停止后台服务。", fontSize = 12.sp, color = dimColor())
            TextButton(onClick = onNotificationSettings) { Text("打开通知设置") }
            Text("如果切到后台后代理断开，请在系统电池设置中允许本应用后台运行。", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "关于") {
            SettingRow("应用", "ZCode Proxy")
            SettingRow("版本", currentVersion ?: "—")
            SettingRow("控制协议", "Node · 127.0.0.1 本地监听")
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("自动检查更新", fontSize = 14.sp, color = cs.onSurfaceVariant)
                    Text("启动时查询 GitHub Releases", fontSize = 12.sp, color = dimColor())
                }
                Switch(checked = autoCheckUpdate, onCheckedChange = onAutoCheckUpdateChange)
            }
            val (updateText, updateColor) = when {
                updateChecking -> "检查中…" to dimColor()
                updateInfo != null ->
                    if (UpdateChecker.isNewer(currentVersion, updateInfo.tag)) {
                        "${updateInfo.tag} 可更新" to cs.primary
                    } else {
                        "已是最新（${updateInfo.tag}）" to successColor()
                    }
                updateCheckFailed -> "检查失败 · GitHub 不可达" to cs.error
                else -> "未检查" to dimColor()
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("更新", fontSize = 14.sp, color = cs.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Text(updateText, fontSize = 13.sp, color = updateColor, modifier = Modifier.weight(1f))
                TextButton(onClick = onCheckUpdate, enabled = !updateChecking) {
                    Text(if (updateChecking) "检查中…" else "检查更新", fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("更新来自 GitHub Releases · zhu748/lealll", fontSize = 12.sp, color = dimColor())
            Text("上游：Z.AI / 智谱开放平台（OAuth 登录）", fontSize = 12.sp, color = dimColor())
        }
    }
}
