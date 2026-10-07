package com.zcode.proxy.http

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** Bound both declared and chunked bodies, then decode complete UTF-8 bytes. */
internal fun InputStream.readUtf8Body(maxBytes: Int, contentLength: Long): String {
    if (contentLength > maxBytes) throw IOException("HTTP 响应过大")
    return use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count > maxBytes - output.size()) throw IOException("HTTP 响应过大")
            output.write(buffer, 0, count)
        }
        output.toString(Charsets.UTF_8.name())
    }
}
