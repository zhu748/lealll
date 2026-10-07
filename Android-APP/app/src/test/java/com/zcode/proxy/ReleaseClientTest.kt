package com.zcode.proxy

import com.zcode.proxy.update.ReleaseClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.TimeUnit

class ReleaseClientTest {
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val payload = """{"tag_name":"v5.0.0","body":"中文🙂"}"""
    private fun client(timeoutMs: Int = 1000) = ReleaseClient(server.url("/releases/latest").toUrl(), timeoutMs)

    @After fun close() { server.shutdown() }

    @Test fun readsChunkedUnicodeAndUsesGithubHeaders() = runBlocking {
        server.enqueue(MockResponse().setChunkedBody(payload, 4))
        val info = client().fetchLatest()!!
        assertEquals("中文🙂", info.notes)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("application/vnd.github+json", request.getHeader("Accept"))
        assertEquals("ZCodeProxy-Android", request.getHeader("User-Agent"))
    }

    @Test fun rejectsOversizedDeclaredAndChunkedBodies() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Length", 1024 * 1024 + 1))
        assertNull(client().fetchLatest())
        server.enqueue(MockResponse().setChunkedBody("x".repeat(1024 * 1024 + 1), 8192))
        assertNull(client().fetchLatest())
    }

    @Test fun treatsRateLimitsAndInvalidJsonAsUnavailable() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403))
        assertNull(client().fetchLatest())
        server.enqueue(MockResponse().setBody("invalid"))
        assertNull(client().fetchLatest())
    }

    @Test fun wholeRequestDeadlineStopsSlowTricklingBody() = runBlocking {
        server.enqueue(MockResponse().setBody(payload).throttleBody(1, 80, TimeUnit.MILLISECONDS))
        val start = System.nanoTime()
        assertNull(client(300).fetchLatest())
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 1500)
    }

    @Test fun clearingCallerDisconnectsInFlightRequest() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job = async { client(10_000).fetchLatest() }
        withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(1, TimeUnit.SECONDS)) }
        withTimeout(1000) { job.cancel(); job.join() }
        assertTrue(job.isCancelled)
    }
}
