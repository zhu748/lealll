package com.zcode.proxy.http

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Owns cancellation and byte limits; endpoint wrappers own headers and JSON. */
internal class JsonHttpTransport : Closeable {
    private val calls = mutableSetOf<Call>()
    private var closed = false

    suspend fun request(request: Request, timeoutMs: Int): String = withContext(Dispatchers.IO) {
        suspendCancellableCoroutine { continuation ->
            require(timeoutMs > 0) { "请求必须设置整次超时" }
            val call = CLIENT.newCall(request).apply { timeout().timeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS) }
            continuation.invokeOnCancellation { call.cancel() }
            try {
                synchronized(calls) {
                    check(!closed) { "HTTP 连接已关闭" }
                    calls.add(call)
                }
                if (!continuation.isActive) return@suspendCancellableCoroutine
                val text = call.execute().use { response ->
                    if (response.code != 200) throw IOException("HTTP 接口返回 HTTP ${response.code}")
                    val body = response.body ?: throw IOException("HTTP 响应为空")
                    body.byteStream().readUtf8Body(MAX_RESPONSE_BYTES, body.contentLength())
                }
                if (continuation.isActive) continuation.resume(text)
            } catch (exception: Exception) {
                if (continuation.isActive) continuation.resumeWithException(exception)
            } finally {
                synchronized(calls) { calls.remove(call) }
                call.cancel()
            }
        }
    }

    override fun close() {
        val active = synchronized(calls) {
            closed = true
            calls.toList().also { calls.clear() }
        }
        active.forEach { it.cancel() }
    }

    companion object {
        private const val MAX_RESPONSE_BYTES = 1024 * 1024
        private val CLIENT = OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            // Every call sets its own deadline. A shared 10-second read
            // default must not shorten the 25-second quota request budget.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            // Replaying a local POST could start OAuth or mutate config twice.
            .retryOnConnectionFailure(false)
            .build()
    }
}
