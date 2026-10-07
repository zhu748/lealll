package com.zcode.proxy

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

class ControlTransportTest {
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val transport = ControlTransport(server.port, "test-control-token")

    @After fun close() {
        transport.close()
        server.shutdown()
    }

    @Test fun readsUtf8UsingByteLengthsAndSendsBearer() = runBlocking {
        val text = """{"ok":true,"message":"已连接中文🙂"}"""
        server.enqueue(MockResponse().setBody(text))
        assertEquals(text, transport.request("{\"cmd\":\"中文\"}", 1000))
        val request = server.takeRequest()
        assertEquals("{\"cmd\":\"中文\"}", request.body.readUtf8())
        assertEquals("Bearer test-control-token", request.getHeader("Authorization"))
    }

    @Test fun readsChunkedResponses() = runBlocking {
        val text = """{"ok":true,"message":"中文🙂"}"""
        server.enqueue(MockResponse().setChunkedBody(text, 4))
        assertEquals(text, transport.request("{}", 1000))
    }

    @Test fun rejectsHttpErrorsRatherThanTreatingThemAsStatus() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        val result = runCatching { transport.request("{}", 1000) }
        assertTrue(result.exceptionOrNull()?.message?.contains("HTTP 401") == true)
    }

    @Test fun rejectsOversizedChunkedResponses() = runBlocking {
        server.enqueue(MockResponse().setChunkedBody("x".repeat(1024 * 1024 + 1), 8192))
        assertTrue(runCatching { transport.request("{}", 1000) }.isFailure)
    }

    @Test fun readTimeoutIsBounded() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val start = System.nanoTime()
        assertTrue(runCatching { transport.request("{}", 150) }.isFailure)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 1500)
    }

    @Test fun cancellationDisconnectsAnInFlightRequest() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job = async { transport.request("{}", 10_000) }
        withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(1, TimeUnit.SECONDS)) }
        withTimeout(1000) { job.cancel(); job.join() }
        assertTrue(job.isCancelled)
    }

    @Test fun closedTransportCannotBeReused() = runBlocking {
        transport.close()
        assertTrue(runCatching { transport.request("{}", 1000) }.isFailure)
    }

    @Test fun disconnectedMutationIsNotAutomaticallyReplayed() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        assertTrue(runCatching { transport.request("{\"cmd\":\"startOAuth\"}", 1000) }.isFailure)
        assertEquals(1, server.requestCount)
    }

    @Test fun closeCancelsActiveRequestBeforeItsDeadline() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job = async { runCatching { transport.request("{}", 10_000) } }
        withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(1, TimeUnit.SECONDS)) }
        val result = withTimeout(1000) { transport.close(); job.await() }
        assertTrue(result.isFailure)
    }

    @Test(timeout = 15_000) fun longRequestUsesItsOwnDeadlineInsteadOfTenSecondDefault() = runBlocking {
        val text = "{\"ok\":true}"
        server.enqueue(MockResponse().setBody(text).setBodyDelay(10_500, TimeUnit.MILLISECONDS))
        assertEquals(text, transport.request("{\"cmd\":\"quota\"}", 12_000))
    }
}
