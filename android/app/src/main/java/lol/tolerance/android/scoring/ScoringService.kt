package lol.tolerance.android.scoring

import android.util.Log
import lol.tolerance.android.api.CreditMonitor
import lol.tolerance.android.api.KeyStore
import lol.tolerance.android.api.ProvisioningClient
import lol.tolerance.android.data.entities.ScoreEntity
import lol.tolerance.android.extraction.PostData

/**
 * Orchestrates the scoring pipeline:
 * 1. Check cache for existing scores
 * 2. Batch uncached posts for API scoring, with the user's topics as narrative themes
 * 3. Apply topic modifiers (hide → 10, show → 0), then cache
 * 4. Return all scores
 *
 * Cache keys carry the spec version and topic set, so scores from an older rubric or
 * different topics are re-scored rather than mixed in.
 */
class ScoringService(
    private val keyStore: KeyStore,
    private val provisioningClient: ProvisioningClient,
    private val topicStore: TopicStore,
    private val credits: CreditMonitor,
) {
    private val cache = ScoreCache()
    private val client = OpenRouterClient(keyStore)

    data class PostScore(
        val postId: String,
        val contentHash: String,
        val score: Int,     // 0-10: 1-10 from the model, 0 for an always-shown topic
        val reason: String,
    )

    /**
     * @param keyRefused the key is out of credit (now or already): posts without a score
     *   weren't attempted, or failed for that reason, and are worth retrying later
     * @param newlyRefused this call found it out, so the user should be told
     */
    data class Outcome(
        val scores: List<PostScore>,
        val keyRefused: Boolean = false,
        val newlyRefused: Boolean = false,
    )

    /**
     * Score a batch of posts. Returns scores for all posts (cached + freshly scored).
     */
    suspend fun scorePosts(posts: List<PostData>): Outcome {
        if (posts.isEmpty()) return Outcome(emptyList())

        // Ensure we have an API key
        ensureApiKey()

        val topics = topicStore.topics()
        val keyPrefix = "v${ScoringSpec.VERSION}:${topicStore.key()}:"
        val results = mutableListOf<PostScore>()
        val uncached = mutableListOf<PostData>()

        val cached = cache.getBatch(posts.map { keyPrefix + it.contentHash })
        for (post in posts) {
            val hit = cached[keyPrefix + post.contentHash]
            if (hit != null) {
                results.add(PostScore(post.id, post.contentHash, hit.score, hit.reason))
            } else {
                uncached.add(post)
            }
        }

        Log.d(TAG, "Cache: ${results.size} hits, ${uncached.size} misses")
        if (uncached.isEmpty()) return Outcome(results)

        // Out of credit: don't call on every screen, just now and then to see if it's back
        if (!credits.mayTry()) return Outcome(results, keyRefused = true)
        credits.recordTry()

        for (batch in uncached.chunked(BATCH_SIZE)) {
            val scored = try {
                client.scoreBatch(batch.map(::toSpecPost), topics.map { it.asTheme() })
            } catch (e: KeyRefusedException) {
                val fresh = credits.markExhausted(e.status)
                return Outcome(results, keyRefused = true, newlyRefused = fresh)
            }
            // Empty means a network or server error, which says nothing about the key
            if (scored.isNotEmpty()) credits.markWorking()
            val entities = mutableListOf<ScoreEntity>()

            for (post in batch) {
                val result = scored[post.contentHash] ?: continue
                val (score, reason) = applyTopics(result, topics)
                results.add(PostScore(post.id, post.contentHash, score, reason))
                entities.add(ScoreEntity(
                    postId = keyPrefix + post.contentHash,
                    apiScore = score,
                    reason = reason,
                    cost = result.cost,
                    platform = post.platform.name,
                ))
            }

            if (entities.isNotEmpty()) cache.putBatch(entities)
        }

        return Outcome(results)
    }

    /** OpenRouter's view of the key in use: its credit left, or that it's refused. */
    suspend fun checkKey(): OpenRouterClient.KeyCheck {
        val key = keyStore.getEffectiveApiKey() ?: return OpenRouterClient.KeyCheck.Failed
        return client.checkKey(key)
    }

    /**
     * The first matched topic decides (the extension lists custom topics first; all of ours
     * are). Its note goes in the reason, so a cover says why it's there.
     */
    private fun applyTopics(result: OpenRouterClient.ScoreResult, topics: List<Topic>): Pair<Int, String> {
        val topic = result.narratives.firstNotNullOfOrNull { topics.getOrNull(it - 1) }
            ?: return result.score to result.reason
        topicStore.recordHit(topic.id, result.reason)
        val note = if (topic.hide) "[Hidden topic: ${topic.name}]" else "[Shown topic: ${topic.name}]"
        val reason = if (result.reason.isBlank()) note else "${result.reason} $note"
        return (if (topic.hide) 10 else 0) to reason
    }

    private fun toSpecPost(post: PostData) = ScoringSpec.Post(
        id = post.contentHash,
        platform = post.platform,
        text = post.text,
        // Extractors give X authors as "@handle" already, or the display name when clipped
        source = post.subreddit ?: post.author,
        likes = post.score,
        comments = post.numComments,
        bodyText = post.details,
        media = post.media,
        length = post.length,
    )

    private suspend fun ensureApiKey() {
        if (!keyStore.isConfigured()) {
            if (keyStore.apiTier == "free") {
                provisioningClient.provisionFreeKey()
            }
        }
    }

    suspend fun clearCache() {
        cache.cleanup()
    }

    companion object {
        private const val TAG = "Tolerance.Scoring"
        // The extension batches 10; larger batches flatten scores toward the middle
        private const val BATCH_SIZE = 10
    }
}
