package lol.tolerance.android.scoring

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
}
