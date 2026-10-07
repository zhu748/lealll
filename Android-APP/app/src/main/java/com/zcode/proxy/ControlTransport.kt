package com.zcode.proxy

import com.zcode.proxy.http.JsonHttpTransport
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class ControlTransport(port: Int, private val token: String) {
    private val endpoint = "http://127.0.0.1:$port/control"
    private val transport = JsonHttpTransport()

    suspend fun request(body: String, timeoutMs: Int): String = transport.request(
        Request.Builder().url(endpoint)
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody(JSON_TYPE)).build(), timeoutMs,
    )

    fun close() { transport.close() }

    companion object { private val JSON_TYPE = "application/json; charset=utf-8".toMediaType() }
}
