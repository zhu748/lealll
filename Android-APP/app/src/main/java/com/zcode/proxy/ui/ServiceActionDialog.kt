package com.zcode.proxy.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable

internal enum class ServiceAction { STOP, RESTART }

@Composable
internal fun ServiceActionDialog(
    action: ServiceAction,
    enabled: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val restart = action == ServiceAction.RESTART
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (restart) "重启后台服务？" else "停止后台服务？") },
        text = {
            Text(if (restart) "当前连接和未完成的授权会中断，配置与登录凭据会保留。重启后需手动启动代理。"
                else "将关闭代理和本地控制服务，当前连接和未完成的授权会中断。配置与登录凭据会保留，可在应用内重新启动。")
        },
        confirmButton = { TextButton(onClick = onConfirm, enabled = enabled) { Text(if (restart) "重启" else "停止") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
