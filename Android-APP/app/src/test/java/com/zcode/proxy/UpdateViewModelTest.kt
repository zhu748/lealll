package com.zcode.proxy

import androidx.lifecycle.ViewModelStore
import com.zcode.proxy.ui.UpdateViewModel
import com.zcode.proxy.update.UpdateInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UpdateViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val store = ViewModelStore()
    private val info = UpdateInfo("v5.0.0", "https://example.test/releases", null, null)

    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { store.clear(); Dispatchers.resetMain() }

    @Test fun rotationAndRepeatedTapsKeepOneRequestAndItsResult() = runModelTest {
        var calls = 0
        val result = CompletableDeferred<UpdateInfo?>()
        val model = model { calls++; result.await() }
        model.initialize("v4.0.0", true, null)
        model.initialize("v4.0.0", true, null)
        model.check()
        runCurrent()
        assertEquals(1, calls)
        assertTrue(model.state.value.checking)
        result.complete(info)
        runCurrent()
        model.initialize("v4.0.0", true, null)
        assertEquals(1, calls)
        assertEquals(info, model.state.value.info)
        assertTrue(model.state.value.showDialog)
        assertFalse(model.state.value.checking)
        model.dismissDialog()
        model.initialize("v4.0.0", true, null)
        assertFalse(model.state.value.showDialog)
    }

    @Test fun manualCheckWorksWithAutomaticChecksOff() = runModelTest {
        var calls = 0
        val model = model { calls++; info }
        model.initialize("v4.0.0", false, null)
        runCurrent()
        assertEquals(0, calls)
        model.check()
        runCurrent()
        assertEquals(1, calls)
        assertTrue(model.state.value.showDialog)
        assertFalse(model.state.value.autoCheck)
    }

    @Test fun manualChecksCanReopenSkippedRelease() = runModelTest {
        val model = model { info }
        model.initialize("v4.0.0", true, info.tag)
        runCurrent()
        assertFalse(model.state.value.showDialog)
        model.check()
        runCurrent()
        assertTrue(model.state.value.showDialog)
        assertEquals(info.tag, model.skipVersion())
        assertFalse(model.state.value.showDialog)
    }

    @Test fun failedManualCheckClearsOldSuccessAndLoading() = runModelTest {
        var result: UpdateInfo? = info
        val model = model { result }
        model.initialize("v4.0.0", true, null)
        runCurrent()
        result = null
        model.check()
        runCurrent()
        assertTrue(model.state.value.failed)
        assertFalse(model.state.value.checking)
        assertFalse(model.state.value.showDialog)
        assertNull(model.state.value.info)
    }

    @Test fun closingViewModelCancelsUpdateWithoutRetainingLoadingState() = runModelTest {
        val result = CompletableDeferred<UpdateInfo?>()
        var cancelled = false
        val model = model { try { result.await() } finally { cancelled = true } }
        model.initialize("v4.0.0", true, null)
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(cancelled)
        assertFalse(model.state.value.checking)
    }

    private fun model(fetch: suspend () -> UpdateInfo?) = UpdateViewModel(fetch).also { store.put("updates", it) }
    private fun runModelTest(body: suspend TestScope.() -> Unit) = runTest {
        try { body() } finally { store.clear(); runCurrent() }
    }
}
