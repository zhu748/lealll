package com.zcode.proxy

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ProcessShutdownTest {
    @Test fun delayedExitIsForcedOnceAndPortIsReleasedBeforeRestart() = runBlocking {
        val child = fixture(5000)
        try {
            val port = child.inputStream.bufferedReader().readLine().toInt()
            val forced = AtomicInteger()
            val shutdown = ProcessShutdown(child, gracePeriodMs = 150) { forced.incrementAndGet(); it.destroyForcibly() }
            val start = System.nanoTime()
            shutdown.request()
            shutdown.request()
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 500)
            shutdown.awaitStopped(3000)
            assertEquals(1, forced.get())
            ServerSocket(port, 1, InetAddress.getByName("127.0.0.1")).use { assertEquals(port, it.localPort) }
        } finally { child.destroyForcibly(); child.waitFor() }
    }

    @Test fun gracefulExitDoesNotRequireForceStop() = runBlocking {
        val child = fixture(0)
        try {
            assertNotNull(child.inputStream.bufferedReader().readLine())
            val forced = AtomicInteger()
            val shutdown = ProcessShutdown(child, gracePeriodMs = 1000) { forced.incrementAndGet(); it.destroyForcibly() }
            shutdown.request()
            shutdown.awaitStopped(3000)
            assertEquals(0, forced.get())
        } finally { child.destroyForcibly(); child.waitFor() }
    }

    @Test fun uncompletedShutdownCannotBeReportedAsStopped() = runBlocking {
        val child = fixture(5000)
        try {
            assertNotNull(child.inputStream.bufferedReader().readLine())
            val shutdown = ProcessShutdown(child, gracePeriodMs = 50) { /* Simulate unavailable force-stop on an older runtime. */ }
            shutdown.request()
            assertTrue(runCatching { shutdown.awaitStopped(150) }.exceptionOrNull() is IOException)
        } finally { child.destroyForcibly(); child.waitFor() }
    }

    private fun fixture(delayMs: Long): Process {
        val java = File(System.getProperty("java.home"), "bin/java").absolutePath
        val classpath = listOf(ProcessFixture::class.java, Unit::class.java).joinToString(File.pathSeparator) { type ->
            File(requireNotNull(type.protectionDomain?.codeSource?.location).toURI()).absolutePath
        }
        return ProcessBuilder(java, "-cp", classpath, ProcessFixture::class.java.name, delayMs.toString())
            .redirectErrorStream(true).start()
    }
}
