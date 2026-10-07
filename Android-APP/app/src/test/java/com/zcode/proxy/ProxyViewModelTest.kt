package com.zcode.proxy

import androidx.lifecycle.ViewModelStore
import com.zcode.proxy.ui.ProxyViewModel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProxyViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val store = ViewModelStore()
    private val client = FakeControl()
    private val runtime = MutableStateFlow(RuntimeSession(RuntimePhase.READY, client = client))
    private lateinit var model: ProxyViewModel

    @Before fun setup() {
        Dispatchers.setMain(dispatcher)
        model = ProxyViewModel(runtime)
        store.put("proxy", model)
    }

    @After fun cleanup() {
        store.clear()
        Dispatchers.resetMain()
    }

    @Test fun pollsOnlyWhileVisibleAndKeepsServerStartTime() = runModelTest {
        client.port = 8080
        client.startedAt = 123456L
        runCurrent()
        assertEquals(0, client.statusCalls)
        model.setVisible(true)
        runCurrent()
        assertEquals(123456L, model.state.value.startedAt)
        model.setVisible(false)
        runCurrent()
        val count = client.statusCalls
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(count, client.statusCalls)
        model.setVisible(true)
        runCurrent()
        assertTrue(client.statusCalls > count)
        assertEquals(123456L, model.state.value.startedAt)
    }

    @Test fun startButtonCannotQueueDuplicateCommands() = runModelTest {
        client.startResult = CompletableDeferred()
        model.setVisible(true)
        runCurrent()
        model.startProxy()
        model.startProxy()
        runCurrent()
        assertEquals(1, client.startCalls)
        assertNotNull(model.state.value.busy)
        client.startResult!!.complete(JSONObject().put("ok", true).put("port", 8080))
        runCurrent()
        assertNull(model.state.value.busy)
        assertEquals(8080, model.state.value.proxyPort)
    }

    @Test fun staleQuotaCannotReplaceDataAfterPlanChanges() = runModelTest {
        client.loggedIn = true
        val old = CompletableDeferred<JSONObject>()
        val current = CompletableDeferred<JSONObject>()
        client.quotaResults.add(old)
        client.quotaResults.add(current)
        model.setVisible(true)
        runCurrent()
        assertTrue(model.state.value.quotaLoading)
        model.changePlan("start-plan")
        runCurrent()
        current.complete(quota("新套餐"))
        runCurrent()
        assertEquals("新套餐", model.state.value.quota!!.rows.first().label)
        old.complete(quota("旧套餐"))
        runCurrent()
        assertEquals("新套餐", model.state.value.quota!!.rows.first().label)
        assertEquals("start-plan", model.state.value.plan)
        assertFalse(model.state.value.quotaLoading)
    }

    @Test fun logoutClearsQuotaEvenIfAnOldRequestCompletesLater() = runModelTest {
        client.loggedIn = true
        val old = CompletableDeferred<JSONObject>()
        client.quotaResults.add(old)
        model.setVisible(true)
        runCurrent()
        model.logout()
        runCurrent()
        old.complete(quota("旧数据"))
        runCurrent()
        assertFalse(model.state.value.loggedIn)
        assertNull(model.state.value.quota)
        assertEquals("idle", model.state.value.quotaStatus)
    }

    @Test fun failedStatusDoesNotLeaveARunningEndpointVisible() = runModelTest {
        client.port = 8080
        model.setVisible(true)
        runCurrent()
        assertTrue(model.state.value.proxyRunning)
        client.statusOk = false
        advanceTimeBy(1500)
        runCurrent()
        assertFalse(model.state.value.reachable)
        assertFalse(model.state.value.proxyRunning)
    }

    @Test fun logsKeepChangingWhenTheBufferIsFull() = runModelTest {
        client.logs = (0..500).map { "line-$it" }
        model.setVisible(true)
        runCurrent()
        assertEquals(500, model.state.value.logs.size)
        val previous = model.state.value.logs
        client.logs = listOf("new-line")
        advanceTimeBy(1500)
        runCurrent()
        assertEquals(500, model.state.value.logs.size)
        assertEquals("new-line", model.state.value.logs.last())
        assertNotEquals(previous, model.state.value.logs)
    }

    private fun runModelTest(body: suspend TestScope.() -> Unit) = runTest {
        try { body() } finally { store.clear(); runCurrent() }
    }

    private fun quota(label: String) = JSONObject().put("ok", true).put("quota", JSONObject()
        .put("serverTime", 1_790_000_000_000L)
        .put("balances", JSONArray().put(JSONObject().put("showName", label).put("remainingUnits", 80).put("totalUnits", 100))))

    private class FakeControl : ControlApi {
        var loggedIn = false
        var statusOk = true
        var provider = "bigmodel"
        var plan = "coding-plan"
        var port = 0
        var startedAt = 0L
        var statusCalls = 0
        var startCalls = 0
        var logs = emptyList<String>()
        var startResult: CompletableDeferred<JSONObject>? = null
        val quotaResults = java.util.ArrayDeque<CompletableDeferred<JSONObject>>()

        override suspend fun status(): JSONObject {
            statusCalls++
            return JSONObject().put("ok", statusOk).put("loggedIn", loggedIn).put("provider", provider)
                .put("plan", plan).put("proxyPort", port).put("proxyStartedAt", startedAt)
        }
        override suspend fun startOAuth(provider: String) = JSONObject().put("ok", true).put("authorizeUrl", "https://example.test/login")
        override suspend fun logout(): JSONObject { loggedIn = false; return JSONObject().put("ok", true) }
        override suspend fun setConfig(provider: String?, plan: String?): JSONObject {
            provider?.let { this.provider = it }; plan?.let { this.plan = it }
            return JSONObject().put("ok", true).put("provider", this.provider).put("plan", this.plan)
        }
        override suspend fun startProxy(): JSONObject {
            startCalls++
            val result = startResult?.await() ?: JSONObject().put("ok", true).put("port", 8080)
            port = result.optInt("port", 0)
            return result
        }
        override suspend fun stopProxy(): JSONObject { port = 0; return JSONObject().put("ok", true) }
        override suspend fun getLogs(since: Int): JSONObject {
            val lines = logs.also { logs = emptyList() }
            return JSONObject().put("ok", true).put("nextSince", since + lines.size).put("lines", JSONArray(lines))
        }
        override suspend fun quota(): JSONObject = withContext(NonCancellable) {
            quotaResults.pollFirst()?.await() ?: JSONObject().put("ok", true).put("quota", JSONObject())
        }
        override fun close() {}
    }
}
