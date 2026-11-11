package lol.tolerance.android.scoring

import android.util.LruCache
import lol.tolerance.android.ToleranceApp
import lol.tolerance.android.data.entities.ScoreEntity

/**
 * Two-layer cache: in-memory LRU + Room database.
 * 24-hour TTL matching the extension.
 */
class ScoreCache {

    private val memCache = LruCache<String, CachedScore>(200)
    private val dao get() = ToleranceApp.instance.database.scoreDao()

    data class CachedScore(
        val score: Int,
        val reason: String,
        val timestamp: Long,
    )

    suspend fun get(postId: String): CachedScore? {
        // Check memory first
        memCache.get(postId)?.let { cached ->
            if (System.currentTimeMillis() - cached.timestamp < TTL_MS) return cached
            memCache.remove(postId)
        }

        // Check Room
        val cutoff = System.currentTimeMillis() - TTL_MS
        val entity = dao.getCached(postId, cutoff) ?: return null
        val cached = CachedScore(entity.apiScore, entity.reason, entity.timestamp)
        memCache.put(postId, cached)
        return cached
    }

    suspend fun getBatch(postIds: List<String>): Map<String, CachedScore> {
        val result = mutableMapOf<String, CachedScore>()
        val missing = mutableListOf<String>()

        // Check memory first
        for (id in postIds) {
            val cached = memCache.get(id)
            if (cached != null && System.currentTimeMillis() - cached.timestamp < TTL_MS) {
                result[id] = cached
            } else {
                missing.add(id)
            }
        }

        // Check Room for remaining
        if (missing.isNotEmpty()) {
            val cutoff = System.currentTimeMillis() - TTL_MS
            val entities = dao.getCachedBatch(missing, cutoff)
            for (entity in entities) {
                val cached = CachedScore(entity.apiScore, entity.reason, entity.timestamp)
                memCache.put(entity.postId, cached)
                result[entity.postId] = cached
            }
        }

        return result
    }

    suspend fun put(postId: String, score: Int, reason: String, cost: Double, platform: String) {
        val now = System.currentTimeMillis()
        memCache.put(postId, CachedScore(score, reason, now))
        dao.insertAll(listOf(
            ScoreEntity(
                postId = postId,
                apiScore = score,
                reason = reason,
                cost = cost,
                platform = platform,
                timestamp = now,
            )
        ))
    }

    suspend fun putBatch(scores: List<ScoreEntity>) {
        for (entity in scores) {
            memCache.put(entity.postId, CachedScore(entity.apiScore, entity.reason, entity.timestamp))
        }
        dao.insertAll(scores)
    }

    suspend fun cleanup() {
        dao.deleteOlderThan(System.currentTimeMillis() - TTL_MS)
    }

    companion object {
        private const val TTL_MS = 24 * 60 * 60 * 1000L // 24 hours
    }
}
