package com.zcode.proxy.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zcode.proxy.update.ReleaseClient
import com.zcode.proxy.update.UpdateChecker
import com.zcode.proxy.update.UpdateInfo
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class UpdateUiState(
    val info: UpdateInfo? = null,
    val checking: Boolean = false,
    val failed: Boolean = false,
    val showDialog: Boolean = false,
    val autoCheck: Boolean = true,
)

/** A single request and dialog survive rotation; no Activity is retained. */
internal class UpdateViewModel(
    private val fetchLatest: suspend () -> UpdateInfo? = { ReleaseClient().fetchLatest() },
) : ViewModel() {
    private val mutable = MutableStateFlow(UpdateUiState())
    val state = mutable.asStateFlow()
    private val messagesChannel = Channel<String>(Channel.BUFFERED)
    val messages = messagesChannel.receiveAsFlow()
    private var initialized = false
    private var currentVersion: String? = null
    private var skippedTag: String? = null

    fun initialize(version: String?, autoCheck: Boolean, skipped: String?) {
        if (initialized) return
        initialized = true
        currentVersion = version
        skippedTag = skipped
        mutable.update { it.copy(autoCheck = autoCheck) }
        if (autoCheck) check(manual = false)
    }

    fun setAutoCheck(enabled: Boolean) { mutable.update { it.copy(autoCheck = enabled) } }
    fun dismissDialog() { mutable.update { it.copy(showDialog = false) } }

    fun skipVersion(): String? = state.value.info?.tag?.also {
        skippedTag = it
        dismissDialog()
    }

    fun check(manual: Boolean = true) {
        if (state.value.checking) return
        mutable.update { it.copy(checking = true, failed = false) }
        viewModelScope.launch {
            try {
                val info = fetchLatest()
                val newer = info != null && UpdateChecker.isNewer(currentVersion, info.tag)
                mutable.update { it.copy(info = info, failed = info == null,
                    showDialog = newer && (manual || info?.tag != skippedTag)) }
                if (manual) messagesChannel.send(when {
                    info == null -> "检查更新失败，GitHub 暂不可达"
                    newer -> "发现新版本 ${info.tag}"
                    else -> "已是最新版本"
                })
            } finally {
                mutable.update { it.copy(checking = false) }
            }
        }
    }
}
