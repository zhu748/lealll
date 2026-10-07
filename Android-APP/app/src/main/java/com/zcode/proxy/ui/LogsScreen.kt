package com.zcode.proxy.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.dimColor

@Composable
internal fun LogsScreen(logs: List<String>, errRegex: Regex, onClear: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val clipboard = LocalClipboardManager.current
    var filter by rememberSaveable { mutableIntStateOf(0) } // 0 全部 1 成功 2 错误
    val successRegex = remember { Regex("\\b2\\d\\d\\b") }
    val filtered = remember(logs, filter) {
        when (filter) {
            1 -> logs.filter { successRegex.containsMatchIn(it) }
            2 -> logs.filter { errRegex.containsMatchIn(it) }
            else -> logs.toList()
        }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(filtered) {
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
        if (filtered.isNotEmpty() && (lastVisible == null || lastVisible >= filtered.lastIndex - 1)) {
            listState.scrollToItem(filtered.lastIndex)
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("实时日志 (${filtered.size})", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = { clipboard.setText(AnnotatedString(filtered.joinToString("\n"))) },
                enabled = filtered.isNotEmpty(),
            ) { Text("复制", fontSize = 13.sp) }
            TextButton(onClick = onClear, enabled = logs.isNotEmpty()) { Text("清屏", fontSize = 13.sp) }
        }
        Row(Modifier.padding(horizontal = 16.dp)) {
            SegChip("全部", filter == 0, true) { filter = 0 }
            Spacer(Modifier.width(8.dp))
            SegChip("成功", filter == 1, true) { filter = 1 }
            Spacer(Modifier.width(8.dp))
            SegChip("错误", filter == 2, true) { filter = 2 }
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 8.dp))
        if (filtered.isEmpty()) {
            Text(
                "暂无日志",
                fontSize = 13.sp,
                color = dimColor(),
                modifier = Modifier.padding(16.dp),
            )
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                contentPadding = PaddingValues(bottom = 110.dp, top = 4.dp),
            ) {
                items(filtered.size) { idx ->
                    val line = filtered[idx]
                    Text(
                        line,
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 1.dp),
                    )
                }
            }
        }
    }
}
