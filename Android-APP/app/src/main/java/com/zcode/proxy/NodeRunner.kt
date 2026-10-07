package com.zcode.proxy

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.runInterruptible
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.UUID
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

class NodeRunner(private val context: Context) {

    // Two independently-allocated loopback ports. The callback port used to be
    // controlPort + 1, which was never validated — a collision surfaced later
    // as EADDRINUSE when the user tapped OAuth Login. The pair is persisted in
    // `control-port` (one port per line; a legacy single-int file is migrated).
    val controlPort: Int
    val callbackPort: Int

    /**
     * Per-start bearer token for the localhost control channel. 127.0.0.1 is
     * shared by every app on the device, so the Node listener rejects any
     * /control request without `Authorization: Bearer <token>` — and a custom
     * header cannot be forged by a no-cors browser fetch either.
     */
    val controlToken: String = UUID.randomUUID().toString().replace("-", "")
    @Volatile private var process: Process? = null

    /** Set by stop(); a process that spawns after this self-destructs. */
    @Volatile private var stopRequested = false

    init {
        val ports = allocateOrReusePorts()
        controlPort = ports.first
        callbackPort = ports.second
    }

    private val logLines = ArrayDeque<String>()

    suspend fun ensureAssetsExtracted() = withContext(Dispatchers.IO) {
        val targetDir = File(context.filesDir, "server_bundle")
        val installedAt = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        val names = listOf("server.cjs", "config.example.yaml", "webui.txt", "zcode_system.json")
        val extracted = BundleExtractor(targetDir).extract(installedAt.toString(), names) { name ->
            context.assets.open("server_bundle/$name")
        }
        Log.i(TAG, if (extracted) "Runtime bundle extracted" else "Runtime bundle reused")
    }

    suspend fun start() = withContext(Dispatchers.IO) {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val libnode = File(nativeDir, "libnode.so")
        require(libnode.exists()) {
            "libnode.so not found in $nativeDir. Did downloadNodeBinary run?"
        }

        val serverBundle = File(context.filesDir, "server_bundle").apply { mkdirs() }
        val serverCjs = File(serverBundle, "server.cjs")
        require(serverCjs.exists()) {
            "server.cjs not found in ${serverBundle.absolutePath}. Did ensureAssetsExtracted() run?"
        }

        val config = File(context.filesDir, "config.yaml")
        if (!config.exists()) {
            config.writeText(DEFAULT_CONFIG)
        }

        val deviceMid = ensureDeviceMid()

        val pb = ProcessBuilder(
            libnode.absolutePath,
            "--no-warnings",
            serverCjs.absolutePath,
            "android",
        ).apply {
            redirectErrorStream(true)
            directory(context.filesDir)
            environment()["HOME"] = context.filesDir.absolutePath
            environment()["LD_LIBRARY_PATH"] = nativeDir
            environment()["NODE_PATH"] = File(serverBundle, "node_modules").absolutePath
            environment()["ZCODE_CONTROL_PORT"] = controlPort.toString()
            environment()["ZCODE_CONTROL_TOKEN"] = controlToken
            environment()["ZCODE_OAUTH_CALLBACK_PORT"] = callbackPort.toString()
            environment()["ZCODE_IDENTITY_PLATFORM"] = "linux"
            environment()["ZCODE_IDENTITY_ARCH"] = "x64"
            environment()["ZCODE_IDENTITY_RELEASE"] = "6.8.0-49-generic"
            environment()["ZCODE_IDENTITY_DEVICE_MID"] = deviceMid
            environment()["ZCODE_PROXY_CONFIG"] = config.absolutePath
            environment()["ZCODE_LOG_FORMAT"] = "compact"
        }

        val p = pb.start()
        process = p
        // stop() may have run while the process was spawning (it saw
        // process == null); destroy the newborn so it cannot become an orphan
        // holding the control/callback ports past service destruction.
        if (stopRequested) {
            stop()
            throw IllegalStateException("NodeRunner.stop() called before start completed")
        }
        Log.i(TAG, "Node.js started (controlPort=$controlPort)")

        Thread({
            try {
                BufferedReader(InputStreamReader(p.inputStream, Charsets.UTF_8)).use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        appendLog(line)
                    }
                }
            } catch (exception: Exception) {
                if (!stopRequested) Log.w(TAG, "Node log stream closed", exception)
            }
            val exit = try { p.exitValue() } catch (_: IllegalThreadStateException) { -1 }
            Log.i(TAG, "Node stdout stream closed (exit=$exit)")
        }, "node-stdout").apply { isDaemon = true }.start()
    }

    fun snapshotLogs(): List<String> = synchronized(logLines) { logLines.toList() }

    fun isAlive(): Boolean = process?.let { running ->
        try { running.exitValue(); false } catch (_: IllegalThreadStateException) { true }
    } ?: false

    fun exitCode(): Int? = try { process?.exitValue() } catch (_: IllegalThreadStateException) { null }

    suspend fun awaitExit(): Int = runInterruptible(Dispatchers.IO) { process?.waitFor() ?: -1 }

    fun stop() {
        stopRequested = true
        val stopped = process ?: return
        stopped.destroy()
        // Do not block the main-thread service callbacks while Node flushes logs.
        Thread({
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                if (!stopped.waitFor(2, TimeUnit.SECONDS)) stopped.destroyForcibly()
            }
        }, "node-stop").apply { isDaemon = true }.start()
    }

    private fun appendLog(line: String) {
        Log.i("Node", line)
        synchronized(logLines) {
            logLines.addLast(line)
            if (logLines.size > LOG_CAPACITY) logLines.removeFirst()
        }
    }

    private fun allocateOrReusePorts(): Pair<Int, Int> {
        val portFile = File(context.filesDir, "control-port")
        if (portFile.exists()) {
            val parts = portFile.readText().trim().split(Regex("\\s+"))
            val cached: Pair<Int, Int>? = when {
                parts.size >= 2 ->
                    parts[0].toIntOrNull()?.let { c ->
                        parts[1].toIntOrNull()?.let { cb -> c to cb }
                    }
                // Legacy single-port file from older builds: callback was
                // controlPort + 1 by convention.
                parts.size == 1 -> parts[0].toIntOrNull()?.let { it to it + 1 }
                else -> null
            }
            if (cached != null && cached.first != cached.second &&
                cached.first in 1..65535 && cached.second in 1..65535 &&
                isPortFree(cached.first) && isPortFree(cached.second)) {
                if (parts.size < 2) portFile.writeText("${cached.first}\n${cached.second}\n")
                return cached
            }
        }
        val control = reservePort()
        var callback = reservePort()
        while (callback == control) callback = reservePort()
        portFile.writeText("$control\n$callback\n")
        return control to callback
    }

    private fun reservePort(): Int {
        ServerSocket().use { s ->
            s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            return s.localPort
        }
    }

    private fun isPortFree(port: Int): Boolean = try {
        ServerSocket().use { it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port)) }
        true
    } catch (e: Exception) {
        false
    }

    /**
     * Stable per-install device identity (X-Device-Mid): random UUIDv4 created
     * once in the app-private dir and reused forever — mirrors ZCode's
     * telemetry deviceMid. Never regenerated while the file exists (fingerprint
     * stability is required by upstream risk engines).
     */
    private fun ensureDeviceMid(): String {
        val f = File(context.filesDir, "device_mid.txt")
        if (f.exists()) {
            val cached = f.readText().trim()
            if (cached.isNotEmpty()) return cached
        }
        val mid = java.util.UUID.randomUUID().toString()
        f.writeText(mid)
        return mid
    }

    companion object {
        private const val TAG = "NodeRunner"
        private const val LOG_CAPACITY = 500
        private val DEFAULT_CONFIG = """
            server:
              host: "127.0.0.1"
              port: 8080
            auth:
              mode: oauth
            provider: bigmodel
            plan: coding-plan
        """.trimIndent()
    }
}
