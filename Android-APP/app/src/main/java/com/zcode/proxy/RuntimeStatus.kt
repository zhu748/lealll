package com.zcode.proxy

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal enum class RuntimePhase { STOPPED, STARTING, STOPPING, READY, FAILED }

internal data class RuntimeSession(
    val phase: RuntimePhase = RuntimePhase.STOPPED,
    val message: String = "后台服务已停止",
    val client: ControlApi? = null,
    val diagnostics: List<String> = emptyList(),
    val proxyPort: Int = 0,
    val userStopped: Boolean = false,
)

/** Service-owned state survives activity recreation; no static Activity references. */
internal object RuntimeStatus {
    private val mutable = MutableStateFlow(RuntimeSession())
    val state = mutable.asStateFlow()

    fun publish(session: RuntimeSession) {
        mutable.value = session
    }

    fun setProxyPort(client: ControlApi, port: Int) {
        mutable.update { if (it.client === client) it.copy(proxyPort = port) else it }
    }
}
