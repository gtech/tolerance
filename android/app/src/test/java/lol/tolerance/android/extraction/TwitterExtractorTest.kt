package lol.tolerance.android.extraction

import android.app.Application
import lol.tolerance.android.scoring.ScoringSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Fixtures are sanitized captures from the Compose X app. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class TwitterExtractorTest {

    private fun load(fixture: String) = ScreenFixture.load("x/$fixture")

    @Test
    fun readsFeedPosts() {
        val posts = TwitterExtractor().extractPosts(load("feed.xml"))
        val whole = posts.filter { !it.isPartial }
        assertEquals(3, whole.size)
        assertTrue(whole.all { it.author.isNotEmpty() && it.text.isNotEmpty() })
        assertTrue(whole.none { it.isAd })
        assertFalse(TwitterExtractor().isReadingScreen(load("feed.xml")))
    }

    @Test
    fun spotsTheAd() {
        val posts = TwitterExtractor().extractPosts(load("feed_with_ad.xml"))
        assertEquals(1, posts.count { it.isAd })
        // Labeled for the model, so a user's own rule can catch it in the Play build
        assertTrue(posts.single { it.isAd }.text.startsWith(ScoringSpec.SPONSORED_PREFIX))
        assertTrue(posts.none { !it.isAd && it.text.startsWith(ScoringSpec.SPONSORED_PREFIX) })
    }

    @Test
    fun postPageIsAReadingScreen() {
        assertTrue(TwitterExtractor().isReadingScreen(load("post_detail.xml")))
    }
}
