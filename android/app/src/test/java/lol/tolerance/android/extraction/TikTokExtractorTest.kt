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

/**
 * Fixtures are sanitized captures from TikTok 47.5.3 and 47.6.3 (one release apart, with
 * reshuffled obfuscated ids). Variants are made by editing the capture as it loads.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class TikTokExtractorTest {

    private fun extract(
        fixture: String,
        liveRoom: Boolean = false,
        edit: (MutableMap<String, String>) -> Boolean = { true },
    ): List<PostData> = TikTokExtractor()
        .apply { inLiveRoom = liveRoom }
        .extractPosts(ScreenFixture.load("tiktok/$fixture", edit))

    private fun single(fixture: String, edit: (MutableMap<String, String>) -> Boolean = { true }): PostData =
        extract(fixture, edit = edit).also { assertEquals("posts in $fixture", 1, it.size) }.single()

    private fun MutableMap<String, String>.id() = this["resource-id"].orEmpty().substringAfter(":id/")

    @Test
    fun readsARecommendedVideo() {
        val post = single("video_47_5.xml")
        assertTrue(post.author.isNotEmpty())
        assertFalse(post.isChosen) // Follow button present: recommended, not chosen
        assertFalse(post.isAd || post.isLive || post.isAiLabeled)
        assertEquals(1_300_000, post.score)
        assertEquals(33_700, post.numComments)
        assertTrue(post.details!!.startsWith("Sound: "))
        assertEquals(ScoringSpec.Media.REEL, post.media)
        assertEquals(ScreenBounds(0, 0, 1080, 2079), post.screenBounds)
    }

    @Test
    fun readsTheNextReleaseToo() {
        // 47.6 moved Like, comments and sound to new ids; descriptions still match
        val post = single("ai_label_47_6.xml")
        assertEquals(55_000, post.score)
        assertEquals(535, post.numComments)
        assertTrue(post.details!!.contains("Sound: "))
        assertFalse(post.isChosen)
    }

    @Test
    fun survivesReshuffledIds() {
        // Every obfuscated id renamed, as a future release might; named ids kept
        val named = setOf("viewpager", "view_rootview", "long_press_layout", "title", "desc", "tv_label")
        val post = single("ai_label_47_6.xml") { attrs ->
            if (attrs.id().isNotEmpty() && attrs.id() !in named) attrs["resource-id"] = "x:id/zz${attrs.id().hashCode()}"
            true
        }
        assertEquals(55_000, post.score)
        assertEquals(535, post.numComments)
        assertFalse(post.isChosen)
        assertTrue(post.isAiLabeled)
    }

    @Test
    fun followedCreatorIsChosen() {
        // No Follow button: the user follows them
        val post = single("video_47_5.xml") { !it["content-desc"].orEmpty().startsWith("Follow ") }
        assertTrue(post.isChosen)
    }

    @Test
    fun followingTabIsChosen() {
        val post = single("video_47_5.xml") { attrs ->
            when (attrs["content-desc"] ?: attrs["text"]) {
                "Following" -> attrs["selected"] = "true"
                "For You" -> attrs["selected"] = "false"
            }
            true
        }
        assertTrue(post.isChosen)
    }

    @Test
    fun aiLabelsInBothReleases() {
        assertTrue(single("ai_label_47_5.xml").isAiLabeled)
        assertTrue(single("ai_label_47_6.xml").isAiLabeled)
        // The caption mentioning it doesn't count
        val captioned = single("video_47_5.xml") { attrs ->
            if (attrs.id() == "desc") attrs["text"] = "Is this AI-generated? Let me know"
            true
        }
        assertFalse(captioned.isAiLabeled)
    }

    @Test
    fun promotionalContentIsAnAd() {
        // Same gray tag as the AI label, different words
        val post = single("ai_label_47_6.xml") { attrs ->
            if (attrs["text"] == "Contains AI-generated media") attrs["text"] = "Promotional content"
            true
        }
        assertTrue(post.isAd)
        assertTrue(post.text.startsWith(ScoringSpec.SPONSORED_PREFIX))

        val caption = single("video_47_5.xml") { attrs ->
            if (attrs.id() == "desc") attrs["text"] = "Promotional content tips for small shops"
            true
        }
        assertFalse(caption.isAd)
    }

    @Test
    fun livePreviewInTheFeed() {
        val post = single("live_preview_47_6.xml")
        assertTrue(post.isLive)
        assertEquals(ScreenBounds(0, 0, 1080, 2079), post.screenBounds)
    }

    @Test
    fun liveRoomIsOneLivePost() {
        val posts = extract("video_47_5.xml", liveRoom = true)
        assertEquals(1, posts.size)
        assertTrue(posts.single().isLive)
    }

    @Test
    fun liveTextElsewhereIsNotAStream() {
        // A "LIVE" ring on a streaming creator's avatar doesn't make their video a stream
        val post = single("video_47_5.xml") { attrs ->
            if (attrs.id() == "title") attrs["content-desc"] = "LIVE"
            true
        }
        assertFalse(post.isLive)
    }
}
