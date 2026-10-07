package com.zcode.proxy

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** HTTP framing stays with the platform: byte lengths, chunking and status codes. */
internal class ControlTransport(port: Int, private val token: String) {
    private val endpoint = URL("http://127.0.0.1:$port/control")
    private val connections = mutableSetOf<HttpURLConnection>()
    private var closed = false

    suspend fun request(body: String, timeoutMs: Int): String = withContext(Dispatchers.IO) {
        suspendCancellableCoroutine { continuation ->
            val connection = endpoint.openConnection() as HttpURLConnection
            continuation.invokeOnCancellation { connection.disconnect() }
            try {
                synchronized(connections) {
                    check(!closed) { "控制连接已关闭" }
                    connections.add(connection)
                }
                if (!continuation.isActive) return@suspendCancellableCoroutine
                connection.apply {
                    requestMethod = "POST"
                    connectTimeout = minOf(timeoutMs, 3_000)
                    readTimeout = timeoutMs
                    instanceFollowRedirects = false
                    useCaches = false
                    doOutput = true
                    setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
                val status = connection.responseCode
                if (status != HttpURLConnection.HTTP_OK) {
                    throw IOException("控制接口返回 HTTP $status")
                }
                if (connection.contentLengthLong > MAX_RESPONSE_BYTES) {
                    throw IOException("控制接口响应过大")
                }
                val text = connection.inputStream.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > MAX_RESPONSE_BYTES) {
                            throw IOException("控制接口响应过大")
                        }
                        output.write(buffer, 0, count)
                    }
                    output.toString(Charsets.UTF_8.name())
                }
                if (continuation.isActive) continuation.resume(text)
            } catch (exception: Exception) {
                if (continuation.isActive) continuation.resumeWithException(exception)
            } finally {
                synchronized(connections) { connections.remove(connection) }
                connection.disconnect()
            }
        }
    }

    fun close() {
        val active = synchronized(connections) {
            closed = true
            connections.toList().also { connections.clear() }
        }
        active.forEach { it.disconnect() }
    }

    companion object {
        private const val MAX_RESPONSE_BYTES = 1024 * 1024
    }
}
