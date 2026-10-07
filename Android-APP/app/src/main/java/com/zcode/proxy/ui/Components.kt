package com.zcode.proxy.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zcode.proxy.ui.theme.Mono

@Composable
internal fun CardBlock(title: String, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        content()
    }
}

@Composable
internal fun SettingRow(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = valueColor)
    }
}

@Composable
internal fun NavItem(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        modifier
            .fillMaxSize()
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .clip(RoundedCornerShape(50))
                .background(if (selected) cs.secondaryContainer else Color.Transparent)
                .padding(horizontal = 16.dp, vertical = 2.dp),
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = if (selected) cs.primary else cs.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) cs.primary else cs.onSurfaceVariant,
        )
    }
}

@Composable
internal fun SegChip(
    text: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = if (selected) cs.primary else cs.background,
        border = if (selected) null else BorderStroke(1.dp, cs.outlineVariant),
        modifier = modifier
            .then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .semantics { testTag = "seg_$text" },
    ) {
        Text(
            text,
            fontFamily = if (mono) Mono else null,
            fontSize = if (mono) 12.sp else 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = when {
                selected -> cs.onPrimary
                !enabled -> cs.onSurfaceVariant.copy(alpha = 0.5f)
                else -> cs.onSurfaceVariant
            },
            textAlign = if (fill) TextAlign.Center else null,
            maxLines = 1,
            modifier = Modifier
                .padding(horizontal = if (mono) 8.dp else 16.dp, vertical = 8.dp)
                .then(if (fill) Modifier.fillMaxWidth() else Modifier),
        )
    }
}

@Composable
internal fun StatusDot(color: Color, pulse: Boolean) {
    if (pulse) {
        val alpha by rememberInfiniteTransition(label = "statusPulse").animateFloat(
            initialValue = 0.12f,
            targetValue = 0.4f,
            animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse),
            label = "statusPulseAlpha",
        )
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(24.dp).clip(CircleShape).background(color.copy(alpha = alpha)))
            Box(Modifier.size(12.dp).clip(CircleShape).background(color))
        }
    } else {
        Box(Modifier.size(12.dp).clip(CircleShape).background(color))
    }
}

@Composable
internal fun CopyGlyph(color: Color) {
    Box(Modifier.size(15.dp)) {
        Box(
            Modifier
                .align(Alignment.TopStart)
                .size(width = 10.dp, height = 12.dp)
                .border(1.5.dp, color, RoundedCornerShape(2.dp)),
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .size(width = 10.dp, height = 12.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(color),
        )
    }
}
