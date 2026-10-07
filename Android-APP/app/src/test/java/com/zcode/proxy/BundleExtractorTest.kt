package com.zcode.proxy

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException

class BundleExtractorTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun reusesBundleUntilApkChangesAndRepairsMissingFiles() {
        val extractor = BundleExtractor(folder.root)
        var opens = 0
        val source: (String) -> ByteArrayInputStream = { opens++; ByteArrayInputStream(it.toByteArray()) }
        val files = listOf("server.cjs", "webui.txt")
        assertTrue(extractor.extract("install-1", files, source))
        assertFalse(extractor.extract("install-1", files, source))
        assertEquals(2, opens)
        File(folder.root, "server.cjs").delete()
        assertTrue(extractor.extract("install-1", files, source))
        assertTrue(extractor.extract("install-2", files, source))
        assertEquals(6, opens)
    }

    @Test fun interruptedUpgradeKeepsOldFileAndRetries() {
        val extractor = BundleExtractor(folder.root)
        val names = listOf("server.cjs")
        extractor.extract("old", names) { ByteArrayInputStream("old bundle".toByteArray()) }
        val result = runCatching { extractor.extract("new", names) { throw IOException("interrupted") } }
        assertTrue(result.isFailure)
        assertEquals("old bundle", File(folder.root, "server.cjs").readText())
        assertTrue(extractor.extract("new", names) { ByteArrayInputStream("new bundle".toByteArray()) })
        assertEquals("new bundle", File(folder.root, "server.cjs").readText())
        assertFalse(folder.root.listFiles().orEmpty().any { it.name.endsWith(".tmp") })
    }
}
