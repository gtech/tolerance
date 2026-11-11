package lol.tolerance.android.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {

    private fun release(tag: String, draft: Boolean = false, prerelease: Boolean = false, apk: String? = "tolerance-android.apk") = mapOf(
        "tag_name" to tag,
        "html_url" to "https://github.com/gtech/tolerance/releases/tag/$tag",
        "draft" to draft,
        "prerelease" to prerelease,
        "assets" to listOfNotNull(apk?.let {
            mapOf("name" to it, "browser_download_url" to "https://github.com/gtech/tolerance/releases/download/$tag/$it")
        }),
    )

    @Test
    fun picksTheNewestAndroidReleaseAmongTheExtensions() {
        // The repo's releases are mostly the extension's (v0.1.x); "latest" is one of those
        val newest = UpdateChecker.newestRelease(listOf(
            release("v0.1.31", apk = "tolerance.zip"),
            release("android-v1.0.0"),
            release("android-v1.10.0"),
            release("android-v1.9.2"),
            release("android-v2.0.0", draft = true),
            release("android-v1.11.0", prerelease = true),
            release("android-latest"),
        ))!!
        assertEquals("1.10.0", newest.version)
        assertEquals("https://github.com/gtech/tolerance/releases/download/android-v1.10.0/tolerance-android.apk", newest.apkUrl)
    }

    @Test
    fun noAndroidReleaseYet() {
        assertNull(UpdateChecker.newestRelease(listOf(release("v0.1.31", apk = "tolerance.zip"))))
    }

    @Test
    fun comparesVersionsNumerically() {
        assertTrue(UpdateChecker.isNewer("1.0.1", "1.0.0"))
        assertTrue(UpdateChecker.isNewer("1.10.0", "1.9.9"))
        assertTrue(UpdateChecker.isNewer("1.0.1", "1.0.0-staging"))
        assertFalse(UpdateChecker.isNewer("1.0.0", "1.0.0"))
        assertFalse(UpdateChecker.isNewer("1.0.0", "1.0.0-play"))
        assertFalse(UpdateChecker.isNewer("0.9.0", "1.0.0"))
    }
}
