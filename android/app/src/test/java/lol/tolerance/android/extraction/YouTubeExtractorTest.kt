package lol.tolerance.android.extraction

import android.app.Application
import lol.tolerance.android.scoring.ScoringSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class YouTubeExtractorTest {

    private fun parse(desc: String) = YouTubeExtractor.parseDescription(desc)!!

    @Test
    fun parsesAVideo() {
        val v = parse("What Orwell Personally Believed - 15 minutes, 25 seconds - Go to channel Ryan Chapman - Ryan Chapman, Verified - 1.8 million views - 5 years ago - play video")
        assertEquals("What Orwell Personally Believed", v.title)
        assertEquals("Ryan Chapman", v.channel)
        assertEquals(1_800_000, v.views)
        assertEquals("15:25", v.length)
        assertFalse(v.isAd)
    }

    @Test
    fun titlesMayContainTheSeparator() {
        val v = parse("Lecture 14 - Linear Programming Duality - 1 hour, 18 minutes, 32 seconds - Go to channel MIT OpenCourseWare - MIT OpenCourseWare - 52K views - 2 years ago - play video")
        assertEquals("Lecture 14 - Linear Programming Duality", v.title)
        assertEquals("1:18:32", v.length)
        assertEquals(52_000, v.views)
    }

    @Test
    fun liveAndShorts() {
        assertEquals("live stream", parse("Lofi beats to study to - Go to channel Lofi Girl - Lofi Girl - 21K watching - play video").length)
        assertEquals("Short", parse("Cat vs cucumber - Go to channel Pets - Pets - 3.4M views - play Short").length)
    }

    @Test
    fun parsesAnAd() {
        val v = parse("Sponsored - Descobre Candlelight\nSonha acordado.\nCandlelight - Visit site - Link opens in new window")
        assertTrue(v.isAd)
        assertEquals("Candlelight", v.channel)
        assertEquals("Descobre Candlelight Sonha acordado.", v.title)
    }

    @Test
    fun ignoresOtherDescriptions() {
        assertNull(YouTubeExtractor.parseDescription("Action menu for What Orwell Personally Believed"))
        assertNull(YouTubeExtractor.parseDescription("6 minutes 21 seconds of 15 minutes 24 seconds"))
    }

    @Test
    fun shortsPlayerIsOneFullScreenPost() {
        val posts = YouTubeExtractor().extractPosts(ScreenFixture.load("youtube/shorts_player_21_44.xml"))
        assertEquals(1, posts.size)
        val player = posts.single()
        assertTrue(player.isShorts && player.isShortsPlayer)
        assertEquals(ScreenBounds(0, 83, 1080, 2082), player.screenBounds)
    }

    @Test
    fun shortsShelfIsCoveredWhole() {
        val posts = YouTubeExtractor().extractPosts(ScreenFixture.load("youtube/shorts_shelf_21_44.xml"))
        val shelf = posts.filter { it.isShorts }
        // The "Shorts" header and the row of Shorts under it, each its own cover
        assertEquals(2, shelf.size)
        assertTrue(shelf.none { it.isShortsPlayer })
        assertEquals(2, shelf.map { it.contentHash }.distinct().size)
        assertEquals(ScreenBounds(0, 1474, 1080, 2214), shelf.last().screenBounds)
        // The ad above it is still read as an ad
        assertTrue(posts.any { it.isAd })
    }

    @Test
    fun readsTheHomeFeed() {
        val posts = YouTubeExtractor().extractPosts(ScreenFixture.load("youtube/home_21_44.xml"))
        assertEquals(2, posts.size)
        val (video, ad) = posts
        assertFalse(video.isAd)
        assertEquals("15:25", video.length)
        assertEquals(1_800_000, video.score)
        assertEquals(ScoringSpec.Media.VIDEO, video.media)
        // The cover spans the card, including the comments teaser under the video
        assertEquals(ScreenBounds(0, 347, 1080, 1433), video.screenBounds)
        assertTrue(ad.isAd)
        assertTrue(ad.text.startsWith(ScoringSpec.SPONSORED_PREFIX))
    }
}
