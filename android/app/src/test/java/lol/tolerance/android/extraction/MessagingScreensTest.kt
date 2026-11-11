package lol.tolerance.android.extraction

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * People's private messages must never reach the scoring API. A post only gets scored if an
 * extractor returns it, so every extractor must find nothing on every messaging screen —
 * inboxes and open conversations alike. (The extension once sent Facebook DMs.)
 *
 * Every fixture named dm_*.xml is checked against every extractor; add captures of new
 * messaging screens (sanitized: scripts/sanitize_dump.py) and they're covered.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class MessagingScreensTest {

    private val extractors = listOf(
        TwitterExtractor(),
        TikTokExtractor(),
        RedditExtractor(),
        YouTubeExtractor(),
        InstagramExtractor(),
    )

    private fun fixtures(messaging: Boolean): List<String> {
        val root = File(javaClass.classLoader!!.getResource("fixtures")!!.toURI())
        return root.walkTopDown()
            .filter { it.isFile && it.extension == "xml" && it.name.startsWith("dm_") == messaging }
            .map { it.relativeTo(root).invariantSeparatorsPath }
            .sorted()
            .toList()
    }

    @Test
    fun noExtractorReadsAMessagingScreen() {
        val fixtures = fixtures(messaging = true)
        assertTrue("no dm_*.xml fixtures found", fixtures.isNotEmpty())
        // In use, extractors have seen the feed first: X remembers post text to recognise
        // posts whose header has scrolled away. Start them in that state.
        for (feed in fixtures(messaging = false)) {
            for (extractor in extractors) extractor.extractPosts(ScreenFixture.load(feed))
        }
        for (fixture in fixtures) {
            for (extractor in extractors) {
                val posts = extractor.extractPosts(ScreenFixture.load(fixture))
                assertEquals("${extractor.platform} read posts from $fixture", emptyList<PostData>(), posts)
            }
        }
    }
}
