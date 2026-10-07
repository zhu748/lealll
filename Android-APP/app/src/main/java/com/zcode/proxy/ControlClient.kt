package com.zcode.proxy

import android.util.Log
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** Commands used by the UI; injectable without an Android process in tests. */
internal interface ControlApi {
    suspend fun status(): JSONObject?
    suspend fun startOAuth(provider: String): JSONObject?
    suspend fun logout(): JSONObject?
    suspend fun setConfig(provider: String? = null, plan: String? = null): JSONObject?
    suspend fun startProxy(): JSONObject?
    suspend fun stopProxy(): JSONObject?
    suspend fun getLogs(since: Int): JSONObject?
    suspend fun quota(): JSONObject?
    fun close()
}

internal class ControlClient(controlPort: Int, controlToken: String) : ControlApi {
    private val transport = ControlTransport(controlPort, controlToken)

    override suspend fun status() = command("status", timeoutMs = 2_000)
    override suspend fun startOAuth(provider: String) = command("startOAuth", JSONObject().put("provider", provider))
    override suspend fun logout() = command("logout")
    override suspend fun startProxy() = command("startProxy")
    override suspend fun stopProxy() = command("stopProxy")
    override suspend fun getLogs(since: Int) = command("getLogs", JSONObject().put("since", since), 2_000)

    // Quota hits multiple upstream APIs; status/logs should still fail quickly.
    override suspend fun quota() = command("quota", timeoutMs = 25_000)

    override suspend fun setConfig(provider: String?, plan: String?): JSONObject {
        val body = JSONObject()
        provider?.let { body.put("provider", it) }
        plan?.let { body.put("plan", it) }
        return command("setConfig", body)
    }

    override fun close() = transport.close()

    private suspend fun command(name: String, body: JSONObject = JSONObject(), timeoutMs: Int = 15_000): JSONObject {
        return try {
            JSONObject(transport.request(body.put("cmd", name).toString(), timeoutMs))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (exception: Exception) {
            Log.w("ControlClient", "$name failed: ${exception.message}")
            JSONObject().put("ok", false).put("error", exception.message ?: "本地服务连接失败")
        }
    }
}
