package com.zcode.proxy

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Non-blocking stop for service callbacks; restarts must await actual exit. */
internal class ProcessShutdown(
    private val process: Process,
    private val gracePeriodMs: Long = 2_000,
    private val forceStop: (Process) -> Unit,
) {
    private val requested = AtomicBoolean(false)

    fun request() {
        if (!requested.compareAndSet(false, true)) return
        process.destroy()
        Thread({
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(gracePeriodMs)
            try {
                while (isRunning() && System.nanoTime() < deadline) Thread.sleep(25)
                if (isRunning()) forceStop(process)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }, "node-stop").apply { isDaemon = true }.start()
    }

    suspend fun awaitStopped(timeoutMs: Long = 4_000) {
        val stopped = withTimeoutOrNull(timeoutMs) {
            while (isRunning()) delay(25)
            true
        } ?: false
        if (!stopped) throw IOException("旧的本地服务尚未退出，请稍候再启动")
    }

    private fun isRunning(): Boolean = try {
        process.exitValue()
        false
    } catch (_: IllegalThreadStateException) { true }
}
