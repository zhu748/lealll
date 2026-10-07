package com.zcode.proxy.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.dimColor
import com.zcode.proxy.ui.theme.isDarkTheme
import com.zcode.proxy.ui.theme.successColor

@Composable
internal fun TopBar(subtitle: String, onSettings: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val appIcon = remember {
            runCatching {
                context.packageManager.getApplicationIcon(context.packageName).toBitmap(96, 96)
            }.getOrNull()
        }
        if (appIcon != null) {
            // 暗色模式下黑底图标需要垫一层提亮底 + 描边，避免糊进背景（方案 A 设计稿同款）
            val dark = isDarkTheme()
            val iconShape = RoundedCornerShape(10.dp)
            Image(
                bitmap = appIcon.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier
                    .size(40.dp)
                    .clip(iconShape)
                    .then(
                        if (dark) Modifier
                            .background(cs.surfaceContainerHigh)
                            .border(1.dp, cs.outlineVariant, iconShape)
                        else Modifier,
                    ),
            )
        } else {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(cs.primary),
                contentAlignment = Alignment.Center,
            ) {
                Text("Z", color = cs.onPrimary, fontWeight = FontWeight.Bold, fontSize = 20.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text("ZCode Proxy", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Text(subtitle, fontSize = 12.sp, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onSettings) {
            Icon(Icons.Filled.Settings, contentDescription = "设置", tint = cs.onSurfaceVariant)
        }
    }
}

@Composable
internal fun HeroCard(
    reachable: Boolean,
    loggedIn: Boolean,
    proxyRunning: Boolean,
    proxyPort: Int,
    plan: String,
    uptimeText: String?,
    quotaUi: QuotaUi?,
    quotaStatus: String,
    quotaErrorMsg: String,
    clipboard: ClipboardManager,
    onCopied: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRefreshQuota: () -> Unit,
    busy: String? = null,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.primaryContainer)
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (dotColor, stateText) = when {
                proxyRunning -> successColor() to "运行中"
                !reachable -> MaterialTheme.colorScheme.error to "本地服务未连接"
                !loggedIn -> cs.onSurfaceVariant to "未登录"
                else -> cs.onSurfaceVariant to "已停止"
            }
            StatusDot(dotColor, pulse = proxyRunning)
            Spacer(Modifier.width(10.dp))
            Text(stateText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onPrimaryContainer)
            Spacer(Modifier.weight(1f))
            Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                Text(
                    plan,
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (proxyRunning) "127.0.0.1:$proxyPort" else "未启动",
                fontFamily = Mono,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onPrimaryContainer,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (proxyRunning) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = Color.Transparent,
                    border = BorderStroke(1.5.dp, cs.primary.copy(alpha = 0.45f)),
                    onClick = {
                        clipboard.setText(AnnotatedString("http://127.0.0.1:$proxyPort/v1"))
                        onCopied()
                    },
                ) {
                    Row(
                        Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CopyGlyph(cs.onPrimaryContainer.copy(alpha = 0.85f))
                        Spacer(Modifier.width(6.dp))
                        Text("复制 /v1", fontSize = 13.sp, color = cs.onPrimaryContainer)
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(
            if (proxyRunning) "OpenAI 客户端使用 /v1 地址；Anthropic 客户端使用 http://127.0.0.1:$proxyPort。"
            else "登录并启动代理后，可复制地址填入本机的编码工具。",
            fontSize = 12.sp,
            color = cs.onPrimaryContainer.copy(alpha = 0.7f),
        )
        Spacer(Modifier.height(14.dp))
        QuotaBlock(
            loggedIn = loggedIn,
            quotaUi = quotaUi,
            status = quotaStatus,
            errorMsg = quotaErrorMsg,
            uptimeText = uptimeText,
            onRefresh = onRefreshQuota,
        )
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = if (proxyRunning) onStop else onStart,
            enabled = busy == null && (if (proxyRunning) reachable else reachable && loggedIn),
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(
                containerColor = cs.primary,
                contentColor = cs.onPrimary,
                disabledContainerColor = cs.onSurfaceVariant.copy(alpha = 0.25f),
                disabledContentColor = cs.onSurfaceVariant,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .semantics { testTag = if (proxyRunning) "stopButton" else "startButton" },
        ) {
            if (busy != null) {
                Text("$busy…", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            } else if (proxyRunning) {
                Box(
                    Modifier
                        .size(14.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimary),
                )
                Spacer(Modifier.width(10.dp))
                Text("停止代理", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            } else {
                Text("启动代理", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
internal fun AccountCard(
    reachable: Boolean,
    loggedIn: Boolean,
    provider: String,
    proxyRunning: Boolean,
    onLogin: () -> Unit,
    onLogout: () -> Unit,
    busy: Boolean = false,
) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(cs.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text("Z", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = cs.onPrimaryContainer)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                if (provider == "zai") "Z.AI 账号" else "智谱账号",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onSurface,
            )
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (loggedIn) successColor() else cs.error),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    when {
                        proxyRunning && loggedIn -> "已登录 · 代理运行中 · 登出已锁定"
                        proxyRunning -> "未登录 · 代理运行中"
                        loggedIn -> "已登录"
                        else -> "未登录"
                    },
                    fontSize = 13.sp,
                    color = cs.onSurfaceVariant,
                )
            }
        }
        if (loggedIn) {
            OutlinedButton(
                onClick = onLogout,
                enabled = reachable && !proxyRunning && !busy,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = cs.error,
                    disabledContentColor = cs.error.copy(alpha = 0.38f),
                ),
                border = BorderStroke(1.5.dp, cs.error.copy(alpha = if (reachable && !proxyRunning) 0.55f else 0.25f)),
                modifier = Modifier.semantics { testTag = "logoutButton" },
            ) {
                Text("登出", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        } else {
            Button(
                onClick = onLogin,
                enabled = reachable && !busy,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = cs.primary, contentColor = cs.onPrimary),
                modifier = Modifier.semantics { testTag = "loginButton" },
            ) {
                Text("登录", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
internal fun AccessConfigCard(
    reachable: Boolean,
    proxyRunning: Boolean,
    provider: String,
    plan: String,
    onProviderChange: (String) -> Unit,
    onPlanChange: (String) -> Unit,
    busy: Boolean = false,
) {
    val cs = MaterialTheme.colorScheme
    val enabled = reachable && !proxyRunning && !busy
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("接入配置", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            Text(
                when {
                    proxyRunning -> "运行中 · 切换已锁定"
                    !reachable -> "本地服务未连接"
                    else -> "停止代理后可切换"
                },
                fontSize = 12.sp,
                color = dimColor(),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("服务商", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("Z.AI", provider == "zai", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("zai") }
            Spacer(Modifier.width(8.dp))
            SegChip("智谱", provider == "bigmodel", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("bigmodel") }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("套餐", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("coding-plan", plan == "coding-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("coding-plan") }
            Spacer(Modifier.width(8.dp))
            SegChip("start-plan", plan == "start-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("start-plan") }
        }
    }
}

@Composable
internal fun LogsPreviewCard(
    logs: List<String>,
    errorCount: Int,
    errRegex: Regex,
    onOpenLogs: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .clickable(onClick = onOpenLogs)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("实时日志", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.width(8.dp))
            Surface(shape = RoundedCornerShape(50), color = cs.secondaryContainer) {
                Text(
                    "${logs.size}",
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                "错误 $errorCount",
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (errorCount == 0) successColor() else cs.error,
            )
            Spacer(Modifier.width(10.dp))
            Text("查看全部", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = cs.primary)
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = cs.primary,
                modifier = Modifier.size(18.dp),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 10.dp))
        if (logs.isEmpty()) {
            Text(
                "还没有请求 — 在编码工具里发一次对话试试",
                fontSize = 12.sp,
                color = dimColor(),
                modifier = Modifier.padding(vertical = 10.dp),
            )
        } else {
            logs.takeLast(5).forEach { line ->
                Text(
                    line,
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                    color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
        }
        Text(
            "点击卡片或右上角「查看全部」查看完整日志",
            fontSize = 12.sp,
            color = dimColor(),
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
        )
    }
}
