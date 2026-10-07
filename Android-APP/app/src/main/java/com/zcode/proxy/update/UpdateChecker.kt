package com.zcode.proxy.update

import android.util.Log
import org.json.JSONObject

/** GitHub Release 元数据（https://github.com/zhu748/lealll/releases）。 */
data class UpdateInfo(
    val tag: String,
    val htmlUrl: String,
    val apkUrl: String?,
    val notes: String?,
)

object UpdateChecker {
    private const val TAG = "UpdateChecker"
    const val RELEASES_PAGE = "https://github.com/zhu748/lealll/releases"

    internal fun parse(text: String): UpdateInfo? = try {
        val json = JSONObject(text)
        val tag = json.optString("tag_name")
        if (tag.isBlank()) {
            null
        } else {
            // Scheme whitelist for server-controlled URLs: html_url /
            // browser_download_url come from the API payload and end up in
            // an Intent / download request — reject anything that is not
            // plain https so a compromised or spoofed payload cannot bounce
            // the user to an app:// or http:// target.
            fun httpsOnly(raw: String): String? = if (raw.startsWith("https://")) raw else null
            UpdateInfo(
                tag = tag,
                htmlUrl = httpsOnly(json.optString("html_url", RELEASES_PAGE).ifBlank { RELEASES_PAGE }) ?: RELEASES_PAGE,
                apkUrl = json.optJSONArray("assets")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                        .filter { it.optString("name").endsWith(".apk", ignoreCase = true) }
                        .filter { httpsOnly(it.optString("browser_download_url")) != null }
                        // 优先签名 release 包，其次 debug 包
                        .sortedBy { if (it.optString("name").contains("release", ignoreCase = true)) 0 else 1 }
                        .firstOrNull()
                        ?.optString("browser_download_url")
                        ?.ifBlank { null }
                        ?.let { httpsOnly(it) }
                },
                notes = json.optString("body").ifBlank { null },
            )
        }
    } catch (t: Exception) {
        Log.w(TAG, "failed to parse release payload: ${t.message}")
        null
    }

    /**
     * 比较主版本、次版本、补丁和 fork/第四段序号，确保 fork.2 能更新 fork.1。
     * current 取自 APK versionName：release CI 直接写入
     * 完整 tag（如 "v5.0.0"），本地/开发构建是 "<package.json 版本>-android"
     * （build.gradle.kts 从仓库 package.json 派生，release CI 会自动 bump 并提交），
     * 因此只有当正式 release 比仓库版本更新时才提示。/releases/latest 不返回
     * prerelease，故无需处理 alpha/beta/rc 后缀。
     */
    fun isNewer(current: String?, latestTag: String): Boolean {
        val lat = numericParts(latestTag)
        if (lat.isEmpty()) return false
        if (current.isNullOrBlank()) return true
        val cur = numericParts(current)
        val n = maxOf(cur.size, lat.size, 3)
        for (i in 0 until n) {
            val c = cur.getOrElse(i) { 0 }
            val l = lat.getOrElse(i) { 0 }
            if (c != l) return l > c
        }
        return false
    }

    private val versionPattern = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:\\.(\\d+)|-fork\\.(\\d+))?(?:-android)?$")

    private fun numericParts(v: String): List<Int> =
        versionPattern
            .find(v.trim())?.let { match ->
                listOf(match.groupValues[1], match.groupValues[2], match.groupValues[3],
                    match.groupValues[4].ifBlank { match.groupValues[5] })
                    .map { if (it.isEmpty()) 0 else it.toIntOrNull() ?: return emptyList() }
            } ?: emptyList()
}
