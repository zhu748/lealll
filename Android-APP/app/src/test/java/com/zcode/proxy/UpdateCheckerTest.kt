package com.zcode.proxy

import com.zcode.proxy.update.UpdateChecker
import org.junit.Assert.*
import org.junit.Test

class UpdateCheckerTest {
    @Test fun recognizesForkReleasesWithoutRepeatedPrompts() {
        assertTrue(UpdateChecker.isNewer("4.7.8-fork.1-android", "v4.7.8-fork.2"))
        assertFalse(UpdateChecker.isNewer("4.7.8-fork.2-android", "v4.7.8-fork.2"))
        assertFalse(UpdateChecker.isNewer("v4.7.8-fork.3", "v4.7.8-fork.2"))
        assertTrue(UpdateChecker.isNewer("4.7.8-fork.99-android", "v4.7.9"))
    }

    @Test fun comparesNumericSegmentsAndRejectsInvalidTags() {
        assertTrue(UpdateChecker.isNewer("4.9.9-android", "v4.10.0"))
        assertTrue(UpdateChecker.isNewer("4.7.8.1-android", "v4.7.8.2"))
        assertFalse(UpdateChecker.isNewer("4.7.8-android", "invalid-release"))
        assertFalse(UpdateChecker.isNewer("v5.0.0", "v4.99.99"))
        assertFalse(UpdateChecker.isNewer(null, "invalid-release"))
        assertFalse(UpdateChecker.isNewer("v5.0.0", "v99.0.0-rc.1"))
        assertFalse(UpdateChecker.isNewer("v5.0.0", "v999999999999.0.0"))
    }

    @Test fun skipsMalformedAndUnsafeAssetsBeforeChoosingReleaseApk() {
        val info = UpdateChecker.parse("""{"tag_name":"v5.0.0","html_url":"app://invalid","body":"中文说明","assets":[
            null,{"name":"release.apk","browser_download_url":"http://unsafe.test/app.apk"},
            {"name":"debug.apk","browser_download_url":"https://example.test/debug.apk"},
            {"name":"release.apk","browser_download_url":"https://example.test/release.apk"}]}""")!!
        assertEquals("https://example.test/release.apk", info.apkUrl)
        assertEquals(UpdateChecker.RELEASES_PAGE, info.htmlUrl)
        assertEquals("中文说明", info.notes)
    }

    @Test fun missingOrInvalidMetadataIsIgnored() {
        assertNull(UpdateChecker.parse("{}"))
        assertNull(UpdateChecker.parse("invalid"))
        assertNull(UpdateChecker.parse("""{"tag_name":" "}"""))
    }
}
