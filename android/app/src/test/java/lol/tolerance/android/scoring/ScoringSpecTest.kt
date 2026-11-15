package lol.tolerance.android.scoring

import lol.tolerance.android.boredom.FeedDelay
import lol.tolerance.android.boredom.ProgressiveBoredomTracker
import lol.tolerance.android.boredom.RankCover
import lol.tolerance.android.boredom.Strictness
import lol.tolerance.android.extraction.Platform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScoringSpecTest {

    private fun post(id: String, platform: Platform = Platform.TWITTER) =
        ScoringSpec.Post(id = id, platform = platform, text = "hello world", source = "@someone", likes = 12, comments = 3)

    @Test
    fun smallBatchesArePaddedWithCalibrationPosts() {
        val padded = ScoringSpec.withCalibration(listOf(post("a")))
        assertEquals(3, padded.size)
        assertTrue(padded.drop(1).all { ScoringSpec.isCalibrationId(it.id) })
        assertTrue(padded.drop(1).all { it.source.startsWith("@") })
        // Big enough batches are left alone
        val three = listOf(post("a"), post("b"), post("c"))
        assertEquals(three, ScoringSpec.withCalibration(three))
    }

    @Test
    fun promptCarriesRubricAdNoteAndThemes() {
        val prompt = ScoringSpec.buildBatchPrompt(
            listOf(post("a", Platform.TIKTOK).copy(media = ScoringSpec.Media.REEL)),
            listOf(ScoringSpec.Theme("crypto", "Posts about crypto")),
        )
        assertTrue(prompt.contains("Measure CHEAP PAYOFF"))
        assertTrue(prompt.contains("Platform: TikTok (short video)"))
        assertTrue(prompt.contains("Creator: @someone"))
        assertTrue(prompt.contains("Give an ad score 10"))
        assertTrue(prompt.contains("1. \"crypto\": Posts about crypto"))
        assertTrue(prompt.contains("\"narratives\": [<theme numbers>]"))
        assertTrue(prompt.contains("Short-form video"))
    }

    @Test
    fun playBuildPromptDoesNotSingleOutAds() {
        val prompt = ScoringSpec.buildBatchPrompt(listOf(post("a")), adNote = false)
        assertFalse(prompt.contains("Advertisements"))
        assertFalse(prompt.contains("ad score 10"))
    }

    @Test
    fun noThemesMeansNoNarrativesField() {
        val prompt = ScoringSpec.buildBatchPrompt(listOf(post("a")))
        assertFalse(prompt.contains("narratives"))
        assertTrue(prompt.contains("Likes: 12, Comments: 3"))
    }

    @Test
    fun scoreFallsBackToSubRatings() {
        assertEquals(7, ScoringSpec.readScore(mapOf("score" to 7.0)))
        assertEquals(7, ScoringSpec.readScore(mapOf("score" to "7")))
        assertEquals(10, ScoringSpec.readScore(mapOf("score" to 14)))
        // hook 9, value 2: 5 + 2 + 2.25 = 9.25 → 9
        assertEquals(9, ScoringSpec.readScore(mapOf("hook" to 9, "effort" to 1, "pull" to 8, "value" to 2)))
        assertNull(ScoringSpec.readScore(mapOf("hook" to 9)))
    }

    @Test
    fun readsNarratives() {
        assertEquals(listOf(2, 1), ScoringSpec.readNarratives(mapOf("narratives" to listOf(2.0, "1"))))
        assertEquals(emptyList<Int>(), ScoringSpec.readNarratives(mapOf("score" to 3)))
    }

    @Test
    fun keyRefusalsStopScoringButProviderHiccupsDont() {
        assertTrue(OpenRouterClient.isKeyRefusal(402, """{"error":{"message":"Insufficient credits"}}"""))
        assertTrue(OpenRouterClient.isKeyRefusal(403, """{"error":{"message":"Key limit exceeded"}}"""))
        assertTrue(OpenRouterClient.isKeyRefusal(401, """{"error":{"message":"No auth credentials found"}}"""))
        assertTrue(OpenRouterClient.isKeyRefusal(429, """{"error":{"message":"Rate limit exceeded"}}"""))
        // The model's provider throttling us says nothing about the key
        assertFalse(OpenRouterClient.isKeyRefusal(429, """{"error":{"message":"anthropic/claude-haiku-5.5 is temporarily rate-limited upstream"}}"""))
        assertFalse(OpenRouterClient.isKeyRefusal(429, """{"error":{"message":"Provider returned error"}}"""))
        assertFalse(OpenRouterClient.isKeyRefusal(500, "Internal error"))
        assertFalse(OpenRouterClient.isKeyRefusal(502, "Bad gateway"))
    }

    @Test
    fun strictnessMatchesTheExtension() {
        // Default: Normal covers only 10s, Reduced 6+, Wind-down 5+
        val default = Strictness.preset(Strictness.DEFAULT_LEVEL).thresholds
        assertTrue(Strictness.isCovered(10, default.normal))
        assertFalse(Strictness.isCovered(9, default.normal))
        assertTrue(Strictness.isCovered(6, default.reduced))
        assertFalse(Strictness.isCovered(5, default.reduced))
        assertTrue(Strictness.isCovered(5, default.windDown))
        // An always-shown topic scores 0 and is never covered
        assertFalse(Strictness.isCovered(0, Strictness.preset(5).thresholds.minimal))
        assertEquals("Very strict", Strictness.preset(99).label)
    }

    @Test
    fun fineTunedThresholdsShowAsTheNearestPreset() {
        val default = Strictness.preset(Strictness.DEFAULT_LEVEL).thresholds
        assertEquals(Strictness.DEFAULT_LEVEL to true, Strictness.closest(default))
        assertEquals(Strictness.DEFAULT_LEVEL to false, Strictness.closest(default.copy(reduced = 60)))
        assertEquals(5 to true, Strictness.closest(Strictness.preset(5).thresholds))
    }

    @Test
    fun feedDelayGrowsEvenlyThroughThePhases() {
        val timing = ProgressiveBoredomTracker.PhaseThresholds(normal = 15.0, reduced = 45.0, windDown = 75.0)
        assertEquals(0, FeedDelay.delayMs(0.0, timing))
        assertEquals(500, FeedDelay.delayMs(7.5, timing))   // halfway through Normal
        assertEquals(1000, FeedDelay.delayMs(15.0, timing))
        assertEquals(1750, FeedDelay.delayMs(30.0, timing)) // halfway through Reduced
        assertEquals(2500, FeedDelay.delayMs(45.0, timing))
        assertEquals(4000, FeedDelay.delayMs(75.0, timing))
        assertEquals(4000, FeedDelay.delayMs(300.0, timing)) // stays there
    }

    @Test
    fun bunchedScoresAreCoveredByRank() {
        // A TikTok-like feed: 40% 8s, 40% 7s, 20% 6s
        val recent = List(20) { 8 } + List(20) { 7 } + List(10) { 6 }
        val hashes = (1..400).map { "video$it" }
        fun coveredShare(score: Int, threshold: Int) =
            hashes.count { RankCover.isCovered(score, it, recent, threshold) } / hashes.size.toDouble()

        // Threshold 100 covers nothing but 10s
        assertEquals(0.0, coveredShare(8, 100), 0.0)
        assertTrue(RankCover.isCovered(10, "ad", recent, 100))
        // 55 is the hookiest 45%: every 8 (40%) and an eighth of the 7s, never a 6
        assertEquals(1.0, coveredShare(8, 55), 0.0)
        assertEquals(0.125, coveredShare(7, 55), 0.06)
        assertEquals(0.0, coveredShare(6, 55), 0.0)
        // 20 is the hookiest 80%: every 8 and 7, no 6
        assertEquals(1.0, coveredShare(7, 20), 0.0)
        assertEquals(0.0, coveredShare(6, 20), 0.0)
        // The same video always gets the same answer
        assertEquals(RankCover.isCovered(7, "video7", recent, 55), RankCover.isCovered(7, "video7", recent, 55))
    }
}
