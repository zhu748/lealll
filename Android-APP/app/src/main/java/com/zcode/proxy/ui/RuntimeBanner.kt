package com.zcode.proxy.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.RuntimePhase
import com.zcode.proxy.RuntimeSession

@Composable
internal fun RuntimeBanner(session: RuntimeSession, reachable: Boolean, onRetry: () -> Unit, onDiagnostics: () -> Unit) {
    val starting = session.phase == RuntimePhase.STARTING
    val message = if (session.phase == RuntimePhase.READY && !reachable) "暂时无法连接本地服务，可重启后重试" else session.message
    CardBlock(if (starting) "正在启动" else "本地服务") {
        Text(message, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!starting) {
            Row {
                TextButton(onClick = onRetry) { Text(if (session.phase == RuntimePhase.READY) "重启服务" else "启动服务") }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = onDiagnostics) { Text("查看诊断") }
            }
        }
    }
}

@Composable
internal fun MessageCard(message: String, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp)) {
        Text(message, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (action != null) TextButton(onClick = onAction) { Text(action) }
    }
}
