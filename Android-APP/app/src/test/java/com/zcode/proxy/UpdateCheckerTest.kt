package com.zcode.proxy

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
    }
}
