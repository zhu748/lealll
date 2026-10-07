package com.zcode.proxy.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.warningColor

@Composable
internal fun QuotaBlock(
    loggedIn: Boolean,
    quotaUi: QuotaUi?,
    status: String,
    errorMsg: String,
    uptimeText: String?,
    onRefresh: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = loggedIn, onClick = onRefresh),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("套餐用量", fontSize = 11.sp, color = cs.onPrimaryContainer.copy(alpha = 0.65f))
            quotaUi?.level?.let { level ->
                Spacer(Modifier.width(8.dp))
                Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                    Text(
                        level,
                        fontFamily = Mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = cs.onPrimaryContainer,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                uptimeText?.let { "UP $it" } ?: "UP —",
                fontFamily = Mono,
                fontSize = 11.sp,
                color = cs.onPrimaryContainer.copy(alpha = 0.65f),
            )
        }
        Spacer(Modifier.height(12.dp))
        val ui = quotaUi
        when {
            !loggedIn -> QuotaHint("登录后显示套餐用量")
            status == "loading" && ui == null -> QuotaPlaceholderRows()
            status == "error" -> Column {
                QuotaHint(if (errorMsg.isBlank()) "用量获取失败" else "用量获取失败 · $errorMsg")
                Spacer(Modifier.height(4.dp))
                Text(
                    "点按重试",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = cs.primary,
                )
            }
            else -> {
                // quotaUi 是委托属性（by remember），不做智能转换 —— 显式取行列表兜底
                val rows = ui?.rows.orEmpty()
                if (rows.isEmpty()) {
                    QuotaHint("暂无用量数据 · 点按刷新")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        rows.forEach { QuotaRow(it) }
                    }
                }
            }
        }
    }
}

@Composable
internal fun QuotaHint(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.5f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
internal fun QuotaPlaceholderRows() {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        listOf(LABEL_5H, LABEL_WEEK).forEach { label ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onPrimaryContainer.copy(alpha = 0.5f),
                )
                Spacer(Modifier.width(10.dp))
                Box(
                    Modifier
                        .weight(1f)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimaryContainer.copy(alpha = 0.08f)),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "…",
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.4f),
                )
            }
        }
    }
}

@Composable
internal fun QuotaRow(row: QuotaRowUi) {
    val cs = MaterialTheme.colorScheme
    val barColor = if (row.striped) {
        cs.primary
    } else {
        when (row.warnLevel) {
            1 -> warningColor()
            2 -> cs.error
            else -> cs.primary
        }
    }
    val valueColor = if (row.striped) cs.onPrimaryContainer else barColor
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            row.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = cs.onPrimaryContainer,
            maxLines = 1,
        )
        Spacer(Modifier.width(10.dp))
        QuotaBar(
            progress = row.progress,
            striped = row.striped,
            color = barColor,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                row.value,
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = valueColor,
            )
            row.resetText?.let { reset ->
                Text(
                    reset,
                    fontFamily = Mono,
                    fontSize = 10.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.55f),
                )
            }
        }
    }
}

@Composable
internal fun QuotaBar(progress: Float?, striped: Boolean, color: Color, modifier: Modifier = Modifier) {
    // 设计稿规格：轨道 primary@12%；coding 条纹 = 8dp 周期 / 4dp 条（45% 叠 15% 底）；
    // credit 实心条随余量缩短并按阈值变色。圆角 3dp 由 clip 统一处理。
    Canvas(modifier.height(6.dp).clip(RoundedCornerShape(3.dp))) {
        drawRect(color.copy(alpha = 0.12f))
        progress?.let { p ->
            val w = size.width * p.coerceIn(0f, 1f)
            if (w <= 0f) return@let
            if (striped) {
                drawRect(color.copy(alpha = 0.15f), size = Size(w, size.height))
                val period = 8.dp.toPx()
                val stripe = 4.dp.toPx()
                var x = 0f
                while (x < w) {
                    drawRect(
                        color.copy(alpha = 0.45f),
                        topLeft = Offset(x, 0f),
                        size = Size(minOf(stripe, w - x), size.height),
                    )
                    x += period
                }
            } else {
                drawRect(color, size = Size(w, size.height))
            }
        }
    }
}
