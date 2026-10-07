package com.zcode.proxy.ui

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/** coding 次数制窗口长度（时间进度条分母）；标签与窗口一一对应。 */
private const val FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000L
private const val WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000L
internal const val LABEL_5H = "5 小时"
internal const val LABEL_WEEK = "每周"

/**
 * 套餐用量行。`progress == null` 时只画轨道（无占比数据可画）。
 * `striped = true` 为 coding 次数制窗口的时间进度条（填充 = 距重置时间进度，斜纹）——
 * 仅在上游没给 percentage 时兜底；有 percentage 时用实心剩余占比条（与 credit 条同语义）。
 * 值恒以「剩」开头（上游 number 可能为脏值，绝不渲染 X/Y，见 pr56/#57 实弹）。
 */
internal data class QuotaRowUi(
    val label: String,
    val value: String,
    val progress: Float?,
    val striped: Boolean,
    /** credit/剩余占比档位：0 充足 / 1 偏低(≤30%) / 2 将尽(≤10%)；时间进度条恒 0。 */
    val warnLevel: Int = 0,
    /** 行内重置提示（如「1h 54m 后重置」/「2026-12-31 到期」）；null 不显示。 */
    val resetText: String? = null,
)

internal data class QuotaUi(
    /** coding 档位字符串（data.level，如 "max"）；credit 制无档位 → null。 */
    val level: String?,
    val rows: List<QuotaRowUi>,
    /** 快照 serverTime（epoch ms）—— 时间进度条以服务端时间为“现在”，免设备时钟偏差。 */
    val nowMs: Long,
)

/** epoch 秒/毫秒并存（上游两种都见过）：>1e12 视为毫秒。 */
private fun toEpochMs(v: Long): Long = if (v > 1_000_000_000_000L) v else v * 1000L

private fun optStringOrNull(o: JSONObject, key: String): String? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optString(key, "").trim().ifBlank { null }
}

private fun optNumberOrNull(o: JSONObject, key: String): Double? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optDouble(key).takeUnless { it.isNaN() }
}

private fun optEpochMsOrNull(o: JSONObject, key: String): Long? =
    optNumberOrNull(o, key)?.toLong()?.let(::toEpochMs)

/**
 * 组装用量块视图。平面按主屏套餐切换选择（coding-plan → monitor 窗口 / start-plan →
 * billing 积分桶），首选平面无行时回退另一平面；level 仅在 coding 行被采用时附带。
 */
internal fun parseQuota(resp: JSONObject, plan: String): QuotaUi? {
    if (!resp.optBoolean("ok", false)) return null
    val quota = resp.optJSONObject("quota") ?: return null
    val nowMs = optNumberOrNull(quota, "serverTime")?.toLong()
        ?.let { if (it > 0) toEpochMs(it) else System.currentTimeMillis() }
        ?: System.currentTimeMillis()
    val coding = quota.optJSONObject("codingPlan")
    val balances = quota.optJSONArray("balances")
    val codingRowsList = codingRows(coding, nowMs)
    val creditRowsList = creditRows(balances, nowMs)
    val level = coding?.let { optStringOrNull(it, "level") }
    return if (plan == "coding-plan") {
        if (codingRowsList.isNotEmpty()) QuotaUi(level, codingRowsList, nowMs)
        else QuotaUi(null, creditRowsList, nowMs)
    } else {
        if (creditRowsList.isNotEmpty()) QuotaUi(null, creditRowsList, nowMs)
        else QuotaUi(level, codingRowsList, nowMs)
    }
}

/** monitor 平面 limits[] 归一后的最小行集（只留渲染要用的字段）。 */
private data class CodingLimitRow(
    val type: String,
    val unit: String?,
    val remaining: Double?,
    val resetMs: Long?,
    /** 上游 percentage = 已用占比（0–100）；缺位/越界为 null。实弹 2026-09-30：2/3/60。 */
    val percentage: Double?,
)

/** 窗口语义名兜底：无重置时间的行退回类型友好名，永不裸显 TIME_LIMIT。 */
private fun friendlyWindowType(type: String): String = when (type) {
    "TOKENS_LIMIT" -> "Token"
    "TIME_LIMIT" -> "周期"
    else -> type.take(10)
}

/**
 * coding 窗口行。窗口名按重置升序的位次 + horizon 校验（5 小时 → 每周 → 月度）——
 * 实弹钉死（2026-09-30，max 档）：三窗口重置分别在 4h30m / 3d18h / 14d，正好落三个
 * 位次，且 5h/每周是 TOKENS_LIMIT 行（按 type 贴标签必然错位）。条画剩余占比
 * （percentage 缺位时 5 小时/每周退回时间进度条纹条）；值 = 剩 remaining 或 剩 P%。
 */
private fun codingRows(coding: JSONObject?, nowMs: Long): List<QuotaRowUi> {
    val limits = coding?.optJSONArray("limits") ?: return emptyList()
    val parsed = buildList {
        for (i in 0 until limits.length()) {
            val o = limits.optJSONObject(i) ?: continue
            val type = optStringOrNull(o, "type") ?: continue
            add(
                CodingLimitRow(
                    type,
                    optStringOrNull(o, "unit"),
                    optNumberOrNull(o, "remaining"),
                    optEpochMsOrNull(o, "nextResetTime"),
                    optNumberOrNull(o, "percentage")?.takeIf { it in 0.0..100.0 },
                ),
            )
        }
    }.sortedWith(compareBy { it.resetMs ?: Long.MAX_VALUE })
    val chosen = parsed.take(3)
    if (chosen.isEmpty()) return emptyList()
    return chosen.mapIndexed { i, l ->
        val horizon = l.resetMs?.let { it - nowMs }
        val label = when {
            i == 0 && horizon != null && horizon <= 6 * 3600_000L -> LABEL_5H
            i == 1 && horizon != null && horizon <= 8 * 86_400_000L -> LABEL_WEEK
            i == 2 && horizon != null && horizon <= 45 * 86_400_000L -> "月度"
            horizon == null -> friendlyWindowType(l.type)
            horizon in 0..(45 * 86_400_000L) -> "月度"
            else -> "周期"
        }
        // percentage = 已用占比（实弹自洽信号；total/number 是脏值，不伪造 X/Y）
        val remainingFrac = l.percentage?.let { ((100f - it.toFloat()) / 100f).coerceIn(0f, 1f) }
        val progress = remainingFrac ?: when (label) {
            LABEL_5H -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / FIVE_HOUR_WINDOW_MS).coerceIn(0f, 1f) }
            LABEL_WEEK -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / WEEK_WINDOW_MS).coerceIn(0f, 1f) }
            else -> null
        }
        val warnLevel = when {
            remainingFrac == null -> 0
            remainingFrac <= 0.10f -> 2
            remainingFrac <= 0.30f -> 1
            else -> 0
        }
        val resetText = l.resetMs?.let { fmtResetCountdown(it, nowMs) }
        val value = when {
            l.remaining != null -> "剩 ${fmtCount(l.remaining.toLong())} ${l.unit ?: "次"}"
            remainingFrac != null -> "剩 ${(remainingFrac * 100).toInt()}%"
            else -> "—"
        }
        QuotaRowUi(
            label,
            value,
            progress,
            striped = remainingFrac == null,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** billing 平面 balances[] 归一后的最小行集。 */
private data class CreditBucket(
    val showName: String,
    val remaining: Double,
    val total: Double,
    val expiresMs: Long?,
)

/**
 * credit 积分桶行。目标结构（用户/官方面板钉死）：5 小时 + 每周双窗口、单一总量池。
 * 桶 → 窗口判别用过期时间升序：最近一桶 8h 内到期才按窗口标签展示，否则（体验套餐
 * 长期桶）回退 showName 标签 —— 桶数不足 2 或形状不符时诚实降级，不硬套窗口语义。
 */
private fun creditRows(balances: JSONArray?, nowMs: Long): List<QuotaRowUi> {
    val arr = balances ?: return emptyList()
    val list = buildList {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            add(
                CreditBucket(
                    optStringOrNull(o, "showName") ?: "",
                    optNumberOrNull(o, "remainingUnits") ?: 0.0,
                    optNumberOrNull(o, "totalUnits") ?: 0.0,
                    optEpochMsOrNull(o, "expiresAt"),
                ),
            )
        }
    }.sortedWith(compareBy { it.expiresMs ?: Long.MAX_VALUE })
    if (list.isEmpty()) return emptyList()
    val nearestExpiry = list[0].expiresMs
    val windowed = list.size >= 2 &&
        nearestExpiry != null &&
        nearestExpiry <= nowMs + 8 * 60 * 60 * 1000L
    return list.take(2).mapIndexed { i, b ->
        val label = when {
            windowed -> if (i == 0) LABEL_5H else LABEL_WEEK
            list.size == 1 -> b.showName.ifBlank { "总额度" }.take(10)
            else -> b.showName.ifBlank { "额度" }.take(10)
        }
        val progress = if (b.total > 0) (b.remaining / b.total).toFloat().coerceIn(0f, 1f) else null
        val frac = if (b.total > 0) b.remaining / b.total else 1.0
        val warnLevel = when {
            b.total <= 0.0 -> 0
            frac <= 0.10 -> 2
            frac <= 0.30 -> 1
            else -> 0
        }
        // 窗口桶显示重置倒计时；长期桶（体验套餐）改为到期日期
        val resetText = b.expiresMs?.let { exp ->
            if (windowed || exp - nowMs <= 7 * 24 * 60 * 60 * 1000L) {
                fmtResetCountdown(exp, nowMs)
            } else {
                fmtExpiryDate(exp)
            }
        }
        QuotaRowUi(
            label,
            "${fmtCredit(b.remaining.toLong())} / ${fmtCredit(b.total.toLong())}",
            progress,
            striped = false,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** `3,894` — 全精度千分位（次数制值的契约，与 TUI fmtUnits 同语义）。 */
private fun fmtCount(n: Long): String =
    DecimalFormat("#,###", DecimalFormatSymbols(Locale.US)).format(n)

/** 重置倒计时：`1h 54m 后重置` / `3d 06h 后重置` / 已过 → `即将重置`。 */
private fun fmtResetCountdown(resetMs: Long, nowMs: Long): String {
    val diff = resetMs - nowMs
    if (diff <= 0) return "即将重置"
    val minutes = diff / 60000L
    return when {
        minutes >= 1440 -> "%dd %02dh 后重置".format(minutes / 1440, (minutes % 1440) / 60)
        minutes >= 60 -> "%dh %02dm 后重置".format(minutes / 60, minutes % 60)
        else -> "${minutes}m 后重置"
    }
}

/** 长期桶到期提示：`2026-12-31 到期`。 */
private fun fmtExpiryDate(expMs: Long): String =
    java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date(expMs)) + " 到期"

/** credit 紧凑展示：≥1e8 亿 / ≥1e4 万（如 6.4万 / 10万），其余千分位。 */
private fun fmtCredit(n: Long): String = when {
    n >= 100_000_000L -> trimScale(n / 1e8) + "亿"
    n >= 10_000L -> trimScale(n / 1e4) + "万"
    else -> fmtCount(n)
}

private fun trimScale(v: Double): String {
    val s = String.format(Locale.US, "%.1f", v)
    return if (s.endsWith(".0")) s.dropLast(2) else s
}
