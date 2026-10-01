package com.zcode.proxy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var nodeJob: Job? = null

    @Volatile private var nodeRunner: NodeRunner? = null
    private var controlClient: ControlClient? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        startForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (nodeJob?.isActive != true) {
            nodeJob = scope.launch {
                // Never spawn a second node while a healthy one is running:
                // every Activity recreate (rotation, app reopen) re-enters here,
                // and each superfluous spawn orphans the previous process.
                if (nodeRunner?.isAlive() == true) return@launch
                val runner = NodeRunner(applicationContext)
                // Registered before start() so onDestroy()->stop() reaches it
                // even while it is still spawning; NodeRunner self-destructs a
                // process that spawns after stop() was requested.
                nodeRunner = runner
                try {
                    runner.ensureAssetsExtracted()
                    runner.start()
                } catch (ce: CancellationException) {
                    runner.stop()
                    throw ce
                } catch (t: Throwable) {
                    runner.stop()
                    Log.e(TAG, "Node.js failed to start", t)
                    startForeground("Node failed: ${t.message ?: t.javaClass.simpleName}")
                    return@launch
                }
                controlClient = ControlClient(runner.controlPort, runner.controlToken).also { it.connect() }
                MainActivity.controlClient = controlClient
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Android 15 (targetSdk 35) enforces a 6h/day runtime cap on `dataSync`
     * foreground services — when it hits, the system calls `onTimeout()` and
     * then stops the service. The default implementation just lets that
     * happen silently: the proxy dies with no user-visible reason. Stop the
     * Node process cleanly here so the ports are released and the state is
     * consistent; the notification (posted by the system) explains the stop.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "foreground service timeout (type=$fgsType) — stopping Node cleanly")
        nodeJob?.cancel()
        controlClient?.close()
        MainActivity.controlClient = null
        nodeRunner?.stop()
        scope.cancel()
        stopSelf(startId)
        super.onTimeout(startId, fgsType)
    }

    override fun onDestroy() {
        nodeJob?.cancel()
        controlClient?.close()
        // Drop the Activity's static reference too — otherwise polling against
        // a dead port reports "Node not responding" until a new service start
        // replaces the client.
        MainActivity.controlClient = null
        nodeRunner?.stop()
        scope.cancel()
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ZCode Proxy Service",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps the proxy server running in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun startForeground(contentText: String = "Running") {
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("ZCode Proxy")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    companion object {
        private const val TAG = "ServerService"
        private const val CHANNEL_ID = "zcode-proxy-service"
        private const val NOTIF_ID = 1001
    }
}
