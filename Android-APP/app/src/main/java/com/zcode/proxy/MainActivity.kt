package com.zcode.proxy

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.zcode.proxy.ui.AccessConfigCard
import com.zcode.proxy.ui.AccountCard
import com.zcode.proxy.ui.AppEvent
import com.zcode.proxy.ui.HeroCard
import com.zcode.proxy.ui.LogsPreviewCard
import com.zcode.proxy.ui.LogsScreen
import com.zcode.proxy.ui.MessageCard
import com.zcode.proxy.ui.NavItem
import com.zcode.proxy.ui.ProxyViewModel
import com.zcode.proxy.ui.RuntimeBanner
import com.zcode.proxy.ui.SettingsScreen
import com.zcode.proxy.ui.TopBar
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.ThemeMode
import com.zcode.proxy.ui.theme.ThemePrefs
import com.zcode.proxy.ui.theme.ZcodeTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var notificationRevision by mutableIntStateOf(0)
    private val notificationPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { notificationRevision++ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        ServerService.requestStart(this)
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) {
            val prefs = getSharedPreferences("notification_prefs", MODE_PRIVATE)
            if (!prefs.getBoolean("requested", false)) {
                prefs.edit().putBoolean("requested", true).apply()
                notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        setContent {
            var themeMode by remember { mutableStateOf(ThemePrefs.load(this)) }
            ZcodeTheme(themeMode) {
                AppScreen(themeMode, notificationRevision) { mode ->
                    themeMode = mode
                    ThemePrefs.save(this, mode)
                }
            }
        }
    }
}

@Composable
private fun AppScreen(themeMode: ThemeMode, notificationRevision: Int, onThemeModeChange: (ThemeMode) -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val model: ProxyViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
    val state by model.state.collectAsStateWithLifecycle()
    val runtime by RuntimeStatus.state.collectAsStateWithLifecycle()
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    val reachable = state.reachable
    val loggedIn = state.loggedIn
    val provider = state.provider
    val plan = state.plan
    val proxyPort = state.proxyPort
    val proxyRunning = state.proxyRunning
    val logs = state.logs
    var toast by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var confirmLogout by remember { mutableStateOf(false) }
    var showDiagnostics by remember { mutableStateOf(false) }
    var notificationsEnabled by remember { mutableStateOf(androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) }

    LaunchedEffect(notificationRevision) {
        notificationsEnabled = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            notificationsEnabled = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
            model.setVisible(true)
            try {
                model.events.collect { event ->
                    when (event) {
                        is AppEvent.Message -> toast = event.text
                        is AppEvent.OpenBrowser -> if (!openInBrowser(context, event.url)) {
                            clipboard.setText(AnnotatedString(event.url))
                            toast = "未找到浏览器，已复制授权链接，请安装浏览器后打开"
                        }
                    }
                }
            } finally {
                model.setVisible(false)
            }
        }
    }

    // 更新检查（GitHub Releases）：每次启动自动查一次，设置页可手动触发
    val currentVersion = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
    }
    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
    var updateChecking by remember { mutableStateOf(false) }
    var updateCheckFailed by remember { mutableStateOf(false) }
    var showUpdateDialog by remember { mutableStateOf(false) }
    var skippedTag by remember { mutableStateOf(UpdatePrefs.loadSkipped(context)) }
    var autoCheckUpdate by remember { mutableStateOf(UpdatePrefs.loadAutoCheck(context)) }

    fun checkForUpdate(manual: Boolean) {
        if (updateChecking) return
        updateChecking = true
        scope.launch {
            val info = try { UpdateChecker.fetchLatest() } finally { updateChecking = false }
            if (info == null) {
                updateCheckFailed = true
                if (manual) toast = "检查更新失败，GitHub 暂不可达"
                return@launch
            }
            updateCheckFailed = false
            updateInfo = info
            val hasUpdate = UpdateChecker.isNewer(currentVersion, info.tag)
            if (manual) toast = if (hasUpdate) "发现新版本 ${info.tag}" else "已是最新版本"
            if (hasUpdate && (manual || info.tag != skippedTag)) showUpdateDialog = true
        }
    }

    // 每次启动自动检查一次（可在设置页关闭；手动检查不受开关影响）
    LaunchedEffect(Unit) { if (autoCheckUpdate) checkForUpdate(manual = false) }

    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.startedAt, lifecycle) {
        lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            nowMs = System.currentTimeMillis()
            if (state.startedAt != null) {
                while (isActive) {
                    delay(1000)
                    nowMs = System.currentTimeMillis()
                }
            }
        }
    }
    LaunchedEffect(toast) {
        if (toast != null) {
            delay(4000)
            toast = null
        }
    }
    val errRegex = remember { Regex("\\b(4\\d\\d|5\\d\\d)\\b") }
    val errorCount = logs.count { errRegex.containsMatchIn(it) }

    val cs = MaterialTheme.colorScheme

    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            when (tab) {
                0 -> {
                    // ── 主页 ──
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(top = 4.dp, start = 16.dp, end = 16.dp, bottom = 120.dp),
                    ) {
                        item {
                            TopBar(
                                subtitle = when {
                                    !reachable -> "本地反向代理 · 连接中"
                                    else -> "本地反向代理 · 已连接"
                                },
                                onSettings = { tab = 2 },
                            )
                        }
                        if (runtime.phase != RuntimePhase.READY || !reachable) {
                            item {
                                RuntimeBanner(
                                    session = runtime,
                                    reachable = reachable,
                                    onRetry = {
                                        if (runtime.phase == RuntimePhase.READY) ServerService.requestRestart(context)
                                        else ServerService.requestStart(context)
                                    },
                                    onDiagnostics = { showDiagnostics = true },
                                )
                            }
                        }
                        state.error?.let { error ->
                            item { MessageCard(error, "关闭", model::dismissError) }
                        }
                        state.busy?.let { busy ->
                            item { MessageCard("$busy… 请稍候") }
                        }
                        if (state.loginPending) {
                            item { MessageCard("正在等待浏览器授权，完成后返回应用。授权未完成时可重新登录。") }
                        }
                        item {
                            HeroCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                proxyRunning = proxyRunning,
                                proxyPort = proxyPort,
                                plan = plan,
                                uptimeText = state.startedAt?.let { formatDuration(nowMs - it) },
                                quotaUi = state.quota,
                                quotaStatus = state.quotaStatus,
                                quotaErrorMsg = state.quotaError,
                                clipboard = clipboard,
                                onCopied = { toast = "已复制 OpenAI Base URL" },
                                onStart = model::startProxy,
                                onStop = model::stopProxy,
                                onRefreshQuota = model::refreshQuota,
                                busy = state.busy,
                            )
                        }
                        item {
                            AccountCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                provider = provider,
                                proxyRunning = proxyRunning,
                                onLogin = model::startLogin,
                                onLogout = { confirmLogout = true },
                                busy = state.busy != null,
                            )
                        }
                        item {
                            AccessConfigCard(
                                reachable = reachable,
                                proxyRunning = proxyRunning,
                                provider = provider,
                                plan = plan,
                                onProviderChange = model::changeProvider,
                                onPlanChange = model::changePlan,
                                busy = state.busy != null || state.loginPending,
                            )
                        }
                        item {
                            LogsPreviewCard(
                                logs = logs,
                                errorCount = errorCount,
                                errRegex = errRegex,
                                onOpenLogs = { tab = 1 },
                            )
                        }
                    }
                }
                1 -> LogsScreen(
                    logs = logs,
                    errRegex = errRegex,
                    onClear = model::clearLogs,
                )
                2 -> SettingsScreen(
                    themeMode = themeMode,
                    onThemeModeChange = onThemeModeChange,
                    provider = provider,
                    plan = plan,
                    proxyPort = proxyPort,
                    proxyRunning = proxyRunning,
                    reachable = reachable,
                    loggedIn = loggedIn,
                    currentVersion = currentVersion,
                    updateInfo = updateInfo,
                    updateChecking = updateChecking,
                    updateCheckFailed = updateCheckFailed,
                    onCheckUpdate = { checkForUpdate(manual = true) },
                    autoCheckUpdate = autoCheckUpdate,
                    notificationsEnabled = notificationsEnabled,
                    onNotificationSettings = { openNotificationSettings(context) },
                    onOpenDashboard = {
                        if (!openInBrowser(context, "http://127.0.0.1:$proxyPort/admin")) toast = "未找到浏览器，请先安装浏览器"
                    },
                    onAutoCheckUpdateChange = { enabled ->
                        autoCheckUpdate = enabled
                        UpdatePrefs.saveAutoCheck(context, enabled)
                    },
                )
            }
        }

        // 底部导航
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
            HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(cs.surfaceContainer)
                    .navigationBarsPadding()
                    .height(68.dp),
            ) {
                NavItem("主页", Icons.Filled.Home, tab == 0, Modifier.weight(1f)) { tab = 0 }
                NavItem("日志", Icons.Filled.Menu, tab == 1, Modifier.weight(1f)) { tab = 1 }
                NavItem("设置", Icons.Filled.Settings, tab == 2, Modifier.weight(1f)) { tab = 2 }
            }
        }

        // toast
        toast?.let { msg ->
            Surface(
                color = cs.inverseSurface,
                contentColor = cs.inverseOnSurface,
                shape = RoundedCornerShape(10.dp),
                shadowElevation = 4.dp,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 100.dp),
            ) {
                Text(msg, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("确认登出？") },
            text = { Text("将删除本应用保存的全部账户凭据。再次使用需要重新登录。") },
            confirmButton = { TextButton(onClick = { confirmLogout = false; model.logout() }) { Text("登出") } },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("取消") } },
        )
    }
    if (showDiagnostics) {
        val diagnostic = (listOf(runtime.message) + runtime.diagnostics).joinToString("\n")
        AlertDialog(
            onDismissRequest = { showDiagnostics = false },
            title = { Text("启动诊断") },
            text = { Text(diagnostic, fontSize = 12.sp, modifier = Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { TextButton(onClick = { clipboard.setText(AnnotatedString(diagnostic)); toast = "已复制诊断信息" }) { Text("复制") } },
            dismissButton = { TextButton(onClick = { showDiagnostics = false }) { Text("关闭") } },
        )
    }

    // 新版本弹窗（启动自动检查 / 设置页手动检查共用）
    if (showUpdateDialog) {
        updateInfo?.let { info ->
            AlertDialog(
                onDismissRequest = { showUpdateDialog = false },
                title = { Text("发现新版本", fontWeight = FontWeight.SemiBold) },
                text = {
                    Column {
                        Text(
                            "最新 ${info.tag} · 当前 ${currentVersion ?: "未知"}",
                            fontFamily = Mono,
                            fontSize = 13.sp,
                            color = cs.onSurfaceVariant,
                        )
                        info.notes?.let { notes ->
                            Spacer(Modifier.height(10.dp))
                            Text(
                                notes.trim(),
                                fontSize = 12.sp,
                                lineHeight = 18.sp,
                                color = cs.onSurfaceVariant,
                                maxLines = 10,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        showUpdateDialog = false
                        if (!openInBrowser(context, info.apkUrl ?: info.htmlUrl)) {
                            clipboard.setText(AnnotatedString(info.apkUrl ?: info.htmlUrl))
                            toast = "未找到浏览器，已复制下载链接"
                        }
                    }) { Text("前往下载", fontWeight = FontWeight.Medium) }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = {
                            skippedTag = info.tag
                            UpdatePrefs.saveSkipped(context, info.tag)
                            showUpdateDialog = false
                        }) { Text("忽略此版本") }
                        TextButton(onClick = { showUpdateDialog = false }) { Text("以后再说") }
                    }
                },
            )
        }
    }
}

/** Return failure to the caller so login/download links can be copied. */
private fun openInBrowser(context: android.content.Context, url: String): Boolean {
    val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
        .setShowTitle(true)
        .build()
    try {
        customTabsIntent.launchUrl(context, android.net.Uri.parse(url))
        return true
    } catch (e: Exception) {
        val fallback = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
        fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(fallback)
            return true
        } catch (_: Exception) {
            return false
        }
    }
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    val h = totalSeconds / 3600
    val m = (totalSeconds % 3600) / 60
    val s = totalSeconds % 60
    return "%02d:%02d:%02d".format(h, m, s)
}

private fun openNotificationSettings(context: android.content.Context) {
    val intent = if (android.os.Build.VERSION.SDK_INT >= 26) {
        Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
    } else {
        Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            android.net.Uri.parse("package:${context.packageName}"))
    }
    context.startActivity(intent)
}
