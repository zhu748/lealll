package com.zcode.proxy.update

import android.util.Log
import com.zcode.proxy.http.JsonHttpTransport
import kotlinx.coroutines.CancellationException
import okhttp3.Request
import java.net.URL

/** Release metadata is optional; network failures never block the local proxy. */
internal class ReleaseClient(
    private val endpoint: URL = URL("https://api.github.com/repos/zhu748/lealll/releases/latest"),
    private val timeoutMs: Int = 12_000,
) {
    suspend fun fetchLatest(): UpdateInfo? = try {
        JsonHttpTransport().use { transport ->
            val request = Request.Builder().url(endpoint)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "ZCodeProxy-Android").build()
            UpdateChecker.parse(transport.request(request, timeoutMs))
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (exception: Exception) {
        Log.i("ReleaseClient", "Update check failed: ${exception.message}")
        null
    }
}
