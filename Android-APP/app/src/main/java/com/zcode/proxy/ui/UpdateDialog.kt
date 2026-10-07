package com.zcode.proxy.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.update.UpdateInfo

@Composable
internal fun UpdateDialog(
    info: UpdateInfo,
    currentVersion: String?,
    onDownload: () -> Unit,
    onSkip: () -> Unit,
    onDismiss: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("发现新版本", fontWeight = FontWeight.SemiBold) },
        text = {
            Column {
                Text("最新 ${info.tag} · 当前 ${currentVersion ?: "未知"}", fontFamily = Mono, fontSize = 13.sp, color = cs.onSurfaceVariant)
                info.notes?.let { notes ->
                    Spacer(Modifier.height(10.dp))
                    Text(notes.trim(), fontSize = 12.sp, lineHeight = 18.sp, color = cs.onSurfaceVariant, maxLines = 10, overflow = TextOverflow.Ellipsis)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDownload) { Text("前往下载", fontWeight = FontWeight.Medium) } },
        dismissButton = {
            Row {
                TextButton(onClick = onSkip) { Text("忽略此版本") }
                TextButton(onClick = onDismiss) { Text("以后再说") }
            }
        },
    )
}
