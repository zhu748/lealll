package com.zcode.proxy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import java.io.IOException

class ServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var nodeJob: Job? = null
    @Volatile private var restartJob: Job? = null
    @Volatile private var nodeRunner: NodeRunner? = null
    @Volatile private var controlClient: ControlClient? = null
    @Volatile private var stopping = false

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        showForeground("正在启动本地服务…")
        scope.launch {
            RuntimeStatus.state.map { it.phase to it.proxyPort }.distinctUntilChanged().collect { (phase, port) ->
                if (phase == RuntimePhase.READY && !stopping) {
                    showForeground(if (port > 0) "代理运行中 · 127.0.0.1:$port" else "本地服务已就绪 · 代理未启动")
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (stopping) return START_NOT_STICKY
        if (intent?.action == ACTION_STOP) {
            stopping = true
            RuntimeStatus.publish(RuntimeSession(RuntimePhase.STOPPING, "正在停止后台服务…", userStopped = true))
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RESTART) {
            if (restartJob?.isActive != true) {
                RuntimeStatus.publish(RuntimeSession(RuntimePhase.STARTING, "正在重启本地服务…"))
                restartJob = scope.launch {
                    nodeJob?.cancelAndJoin()
                    if (!stopping) nodeJob = scope.launch { runNode() }
                }
            }
            return START_STICKY
        }
        if (restartJob?.isActive == true) return START_STICKY
        if (nodeJob?.isActive != true) {
            nodeJob = scope.launch { runNode() }
        }
        return START_STICKY
    }

    private suspend fun runNode() {
        if (stopping) return
        RuntimeStatus.publish(RuntimeSession(RuntimePhase.STARTING, "正在准备本地服务…"))
        var runner: NodeRunner? = null
        var client: ControlClient? = null
        try {
            runner = NodeRunner(applicationContext)
            nodeRunner = runner
            runner.ensureAssetsExtracted()
            runner.start()
            client = ControlClient(runner.controlPort, runner.controlToken)
            controlClient = client
            // A spawned process is not ready until its authenticated listener responds.
            withTimeout(20_000) {
                while (isActive) {
                    if (!runner.isAlive()) throw IOException("本地服务提前退出（代码 ${runner.exitCode()}）")
                    if (client.status()?.optBoolean("ok", false) == true) break
                    delay(250)
                }
            }
            RuntimeStatus.publish(RuntimeSession(RuntimePhase.READY, "本地服务已连接", client))
            val code = runner.awaitExit()
            throw IOException("本地服务意外退出（代码 $code），请重试")
        } catch (cancelled: CancellationException) {
            // A readiness timeout is actionable; destruction cancellation is expected.
            if (cancelled is kotlinx.coroutines.TimeoutCancellationException && !stopping) {
                fail("本地服务启动超时，请查看诊断并重试", cancelled)
            }
            else throw cancelled
        } catch (exception: Exception) {
            if (!stopping) fail(exception.message ?: "本地服务启动失败", exception)
        } finally {
            client?.close()
            runner?.stop()
            // cancelAndJoin must release the proxy port before a replacement starts.
            withContext(NonCancellable) {
                try { runner?.awaitStopped() }
                catch (exception: IOException) {
                    if (!stopping) fail(exception.message ?: "本地服务未退出", exception)
                }
            }
            if (controlClient === client) controlClient = null
            if (nodeRunner === runner) nodeRunner = null
        }
    }

    private fun fail(message: String, exception: Exception) {
        stopping = true
        Log.e("ServerService", message, exception)
        RuntimeStatus.publish(RuntimeSession(RuntimePhase.FAILED, message, diagnostics = nodeRunner?.snapshotLogs()?.takeLast(40).orEmpty()))
        stopForeground(STOP_FOREGROUND_DETACH)
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT < 33 || manager.areNotificationsEnabled()) {
            manager.notify(NOTIF_ID, notification(message, ongoing = false))
        }
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopping = true
        RuntimeStatus.publish(RuntimeSession(RuntimePhase.FAILED, "系统已停止后台服务，请回到应用重试"))
        controlClient?.close()
        nodeRunner?.stop()
        stopSelf(startId)
    }

    override fun onDestroy() {
        stopping = true
        val runner = nodeRunner
        val job = nodeJob
        val userStopped = RuntimeStatus.state.value.userStopped
        nodeJob?.cancel()
        controlClient?.close()
        nodeRunner?.stop()
        scope.cancel()
        if (RuntimeStatus.state.value.phase != RuntimePhase.FAILED) {
            RuntimeStatus.publish(RuntimeSession(RuntimePhase.STOPPING, "正在停止后台服务…", userStopped = userStopped))
            stopForeground(STOP_FOREGROUND_REMOVE)
            // This bounded cleanup outlives the cancelled service scope.
            CoroutineScope(Dispatchers.IO).launch {
                val error = try { job?.join(); runner?.awaitStopped(); null }
                catch (exception: IOException) { exception.message }
                if (RuntimeStatus.state.value.phase == RuntimePhase.STOPPING) {
                    RuntimeStatus.publish(if (error == null) {
                        RuntimeSession(message = "后台服务已停止，可在应用内重新启动", userStopped = userStopped)
                    } else RuntimeSession(RuntimePhase.FAILED, error, userStopped = userStopped))
                }
            }
        }
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "本地代理服务", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示代理状态，可打开应用或停止后台服务"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String, ongoing: Boolean): Notification {
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ZCode Proxy")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
        if (ongoing) {
            val stop = PendingIntent.getService(this, 1, Intent(this, ServerService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.addAction(0, "停止服务", stop)
        }
        return builder.build()
    }

    private fun showForeground(text: String) {
        val notification = notification(text, ongoing = true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    companion object {
        private const val CHANNEL_ID = "zcode-proxy-service"
        private const val NOTIF_ID = 1001
        private const val ACTION_STOP = "com.zcode.proxy.STOP_SERVICE"
        private const val ACTION_RESTART = "com.zcode.proxy.RESTART_SERVICE"

        fun requestStop(context: Context) {
            RuntimeStatus.publish(RuntimeSession(RuntimePhase.STOPPING, "正在停止后台服务…", userStopped = true))
            if (!context.stopService(Intent(context, ServerService::class.java))) {
                RuntimeStatus.publish(RuntimeSession(message = "后台服务已停止，可在应用内重新启动", userStopped = true))
            }
        }

        fun requestRestart(context: Context) {
            if (RuntimeStatus.state.value.phase == RuntimePhase.STOPPING) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, ServerService::class.java).setAction(ACTION_RESTART))
            } catch (exception: Exception) {
                RuntimeStatus.publish(RuntimeSession(RuntimePhase.FAILED, exception.message ?: "无法重启后台服务"))
            }
        }

        fun requestStart(context: Context) {
            if (RuntimeStatus.state.value.phase == RuntimePhase.STOPPING) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, ServerService::class.java))
            } catch (exception: Exception) {
                RuntimeStatus.publish(RuntimeSession(RuntimePhase.FAILED, exception.message ?: "系统不允许启动后台服务，请重试"))
            }
        }
    }
}
