package com.zcode.proxy.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zcode.proxy.ControlApi
import com.zcode.proxy.RuntimePhase
import com.zcode.proxy.RuntimeSession
import com.zcode.proxy.RuntimeStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

internal data class ProxyUiState(
    val reachable: Boolean = false,
    val loggedIn: Boolean = false,
    val provider: String = "bigmodel",
    val plan: String = "coding-plan",
    val proxyPort: Int = 0,
    val startedAt: Long? = null,
    val loginPending: Boolean = false,
    val logs: List<String> = emptyList(),
    val quota: QuotaUi? = null,
    val quotaStatus: String = "idle",
    val quotaError: String = "",
    val quotaLoading: Boolean = false,
    val busy: String? = null,
    val error: String? = null,
) {
    val proxyRunning: Boolean get() = proxyPort > 0
    val canAct: Boolean get() = reachable && busy == null
}

internal sealed interface AppEvent {
    data class Message(val text: String) : AppEvent
    data class OpenBrowser(val url: String) : AppEvent
}

/** Retains state on rotation and owns request cancellation, rather than UI cards. */
internal class ProxyViewModel(
    private val runtime: StateFlow<RuntimeSession> = RuntimeStatus.state,
) : ViewModel() {
    private val mutable = MutableStateFlow(ProxyUiState())
    val state = mutable.asStateFlow()
    private val eventsChannel = Channel<AppEvent>(Channel.BUFFERED)
    val events = eventsChannel.receiveAsFlow()
    private val visible = MutableStateFlow(false)
    private var activeClient: ControlApi? = null
    private var logCursor = 0
    private var revision = 0L
    private var quotaEpoch = 0L
    private var quotaJob: Job? = null

    init {
        viewModelScope.launch {
            // Port updates only change the notification, not the control session.
            val sessions = runtime.map { it.copy(proxyPort = 0) }.distinctUntilChanged()
            combine(sessions, visible) { session, showing -> session to showing }.collectLatest { (session, showing) ->
                if (session.client !== activeClient) {
                    activeClient = session.client
                    logCursor = 0
                    resetQuota()
                    mutable.update { ProxyUiState(logs = it.logs) }
                }
                val client = session.client
                if (session.phase != RuntimePhase.READY || client == null) {
                    mutable.update { it.copy(reachable = false, loggedIn = false, proxyPort = 0, startedAt = null, loginPending = false) }
                    return@collectLatest
                }
                if (!showing) return@collectLatest
                while (isActive) {
                    refreshStatus(client)
                    val response = client.getLogs(logCursor)
                    if (response?.optBoolean("ok", false) == true) {
                        val lines = response.optJSONArray("lines")
                        val newLines = if (lines == null) emptyList() else (0 until lines.length()).map { lines.getString(it) }
                        logCursor = response.optInt("nextSince", logCursor)
                        if (newLines.isNotEmpty()) mutable.update { it.copy(logs = (it.logs + newLines).takeLast(MAX_LOG_LINES)) }
                    }
                    delay(POLL_INTERVAL_MS)
                }
            }
        }
    }

    fun setVisible(value: Boolean) { visible.value = value }
    fun clearLogs() { mutable.update { it.copy(logs = emptyList()) } }
    fun dismissError() { mutable.update { it.copy(error = null) } }

    fun refreshQuota() {
        val client = activeClient ?: return
        val current = state.value
        if (!current.loggedIn || !current.reachable || current.quotaLoading) return
        val epoch = quotaEpoch
        val plan = current.plan
        mutable.update { it.copy(quotaLoading = true, quotaStatus = if (it.quota == null) "loading" else it.quotaStatus) }
        quotaJob = viewModelScope.launch {
            try {
                val response = client.quota()
                if (epoch != quotaEpoch || activeClient !== client) return@launch
                if (response?.optBoolean("ok", false) == true) {
                    val quota = parseQuota(response, plan)
                    mutable.update { it.copy(quota = quota, quotaStatus = if (quota?.rows.isNullOrEmpty()) "empty" else "ok", quotaError = "") }
                } else {
                    mutable.update { it.copy(quotaStatus = "error", quotaError = response.errorText()) }
                }
            } finally {
                if (epoch == quotaEpoch) mutable.update { it.copy(quotaLoading = false) }
            }
        }
    }

    private fun resetQuota() {
        quotaEpoch++
        quotaJob?.cancel()
        quotaJob = null
        mutable.update { it.copy(quota = null, quotaStatus = "idle", quotaError = "", quotaLoading = false) }
    }

    private suspend fun refreshStatus(client: ControlApi) {
        val before = revision
        val response = client.status()
        if (client !== activeClient || before != revision || state.value.busy != null) return
        if (response?.optBoolean("ok", false) != true) {
            // Never present an old running endpoint as a live connection.
            mutable.update { it.copy(reachable = false, proxyPort = 0, startedAt = null) }
            return
        }
        val old = state.value
        val loggedIn = response.optBoolean("loggedIn", false)
        val provider = response.optString("provider", old.provider)
        val plan = response.optString("plan", old.plan)
        val changed = old.loggedIn != loggedIn || old.provider != provider || old.plan != plan
        if (changed) resetQuota()
        val port = response.optInt("proxyPort", 0)
        mutable.update {
            it.copy(reachable = true, loggedIn = loggedIn, provider = provider, plan = plan,
                proxyPort = port, startedAt = response.optLong("proxyStartedAt", 0).takeIf { value -> value > 0 },
                loginPending = response.optBoolean("oauthPending", false))
        }
        RuntimeStatus.setProxyPort(client, port)
        if (changed && loggedIn) refreshQuota()
        if (old.loginPending && !loggedIn && !state.value.loginPending) {
            mutable.update { it.copy(error = "授权未完成或已过期，请重新登录；详情可查看日志") }
        }
    }

    fun changeProvider(provider: String) = action("切换服务商", { it.setConfig(provider = provider) }) {
        resetQuota()
        mutable.update { state -> state.copy(provider = it.optString("provider", provider), loggedIn = false) }
        message("服务商已切换")
    }

    fun changePlan(plan: String) = action("切换套餐", { it.setConfig(plan = plan) }) {
        resetQuota()
        mutable.update { state -> state.copy(plan = it.optString("plan", plan), loggedIn = false) }
        message("套餐已切换")
    }

    fun startLogin() = action("打开授权", { it.startOAuth(state.value.provider) }) {
        val url = it.optString("authorizeUrl")
        if (url.isBlank()) {
            mutable.update { state -> state.copy(error = "未获取到授权链接，请重试") }
        } else {
            mutable.update { state -> state.copy(loginPending = true) }
            viewModelScope.launch { eventsChannel.send(AppEvent.OpenBrowser(url)) }
        }
    }

    fun logout() = action("登出", { it.logout() }) {
        resetQuota()
        mutable.update { state -> state.copy(loggedIn = false, loginPending = false) }
        message("已登出")
    }

    fun startProxy() = action("启动代理", { it.startProxy() }) {
        val port = it.optInt("port", 0)
        mutable.update { state -> state.copy(proxyPort = port, startedAt = it.optLong("startedAt", 0).takeIf { value -> value > 0 }) }
        activeClient?.let { client -> RuntimeStatus.setProxyPort(client, port) }
        message("代理已启动")
    }

    fun stopProxy() = action("停止代理", { it.stopProxy() }) {
        mutable.update { state -> state.copy(proxyPort = 0, startedAt = null) }
        activeClient?.let { client -> RuntimeStatus.setProxyPort(client, 0) }
        message("代理已停止")
    }

    private fun action(title: String, command: suspend (ControlApi) -> JSONObject?, success: (JSONObject) -> Unit) {
        val client = activeClient ?: return
        if (!state.value.canAct) return
        revision++
        mutable.update { it.copy(busy = title, error = null) }
        viewModelScope.launch {
            try {
                val response = command(client)
                if (activeClient !== client) return@launch
                if (response?.optBoolean("ok", false) == true) success(response)
                else mutable.update { it.copy(error = "$title 失败：${response.errorText()}") }
            } finally {
                if (activeClient === client) mutable.update { it.copy(busy = null) }
            }
            if (activeClient === client) refreshStatus(client)
        }
    }

    private fun message(text: String) {
        viewModelScope.launch { eventsChannel.send(AppEvent.Message(text)) }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 1500L
        private const val MAX_LOG_LINES = 500
    }
}

private fun JSONObject?.errorText(): String {
    val raw = this?.optString("error")?.takeIf { it.isNotBlank() } ?: "本地服务未响应，请重试"
    return when {
        raw == "not_logged_in" -> "请先登录对应的服务商和套餐"
        raw == "stop_proxy_first" -> "请先停止代理"
        raw == "already_running" -> "代理已经运行"
        raw.contains("EADDRINUSE") -> "端口被占用，请停止占用该端口的应用后重试"
        else -> raw
    }
}
