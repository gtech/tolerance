package lol.tolerance.android.boredom

import android.content.SharedPreferences

/**
 * Covering by rank, for feeds whose scores bunch together. Nearly every TikTok video scores
 * 7 or 8, so an absolute threshold covers nothing and then, one step down, everything. Here
 * the threshold is read as a share instead: at threshold T, the hookiest (100 − T)% of
 * recently scored videos are covered. Coverage then grows evenly with the phases, however
 * compressed the scores are.
 */
object RankCover {

    /** Share of videos covered at [threshold]: none at 100, 45% at 55, 80% at 20. */
    fun share(threshold: Int): Double = ((100 - threshold) / 100.0).coerceIn(0.0, 1.0)

    /**
     * Whether a video scoring [score] is in the hookiest share of [recent] scores.
     *
     * Scores are whole numbers, so many videos tie. When the cut falls inside a tie, part
     * of it is covered, picked by [contentHash] so a given video always gets the same answer.
     */
    fun isCovered(score: Int, contentHash: String, recent: List<Int>, threshold: Int): Boolean {
        // 10s are ads and hidden topics: covered whatever the feed looks like
        if (score >= 10) return true
        val share = share(threshold)
        if (share <= 0.0 || recent.isEmpty()) return false

        val above = recent.count { it > score }.toDouble() / recent.size
        val tied = recent.count { it == score }.toDouble() / recent.size
        return when {
            above >= share -> false
            above + tied <= share -> true
            else -> tieBreak(contentHash) < (share - above) / tied
        }
    }

    /** A fixed number in [0, 1) for a post. */
    private fun tieBreak(contentHash: String): Double =
        (contentHash.hashCode() and 0x7fffffff) % 1000 / 1000.0
}

/**
 * The last [CAPACITY] scores from one feed, kept across restarts so ranking doesn't start
 * from nothing each time. Main thread only.
 */
class RecentScores(private val prefs: SharedPreferences, private val key: String) {

    private val scores = ArrayDeque<Int>()

    init {
        val saved = prefs.getString(key, null)?.split(',')?.mapNotNull { it.toIntOrNull() }
        // Nothing yet: start from what TikTok's feed usually looks like, so the first
        // videos aren't ranked against an empty list
        scores.addAll(saved?.takeIf { it.isNotEmpty() } ?: TYPICAL)
    }

    fun list(): List<Int> = scores

    fun add(score: Int) {
        // 10s are forced by ads and hidden topics; they say nothing about the feed's spread
        if (score >= 10) return
        scores.addLast(score)
        while (scores.size > CAPACITY) scores.removeFirst()
        prefs.edit().putString(key, scores.joinToString(",")).apply()
    }

    companion object {
        private const val CAPACITY = 50
        private val TYPICAL = listOf(5, 6, 6, 7, 7, 7, 7, 8, 8, 8)
    }
}
