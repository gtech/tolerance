package lol.tolerance.android.boredom

/**
 * How long each video in a paging feed (TikTok's For You) is held under a cover before it
 * shows. TikTok's captions say too little to score, so instead of judging videos this makes
 * every one cost a wait: the opening hook plays unseen, and the feed's own recommender gets
 * the same extra watch time on everything.
 *
 * The wait grows with the day's minutes, a straight line between the phase boundaries, so
 * there is never a step the user feels.
 */
object FeedDelay {

    // Seconds of wait at the start of the day and at the end of each phase. Small on
    // purpose: to be raised as we learn how much the feed and its users can take.
    private const val AT_START = 0.0
    private const val AT_NORMAL_END = 1.0
    private const val AT_REDUCED_END = 2.5
    private const val AT_WIND_DOWN_END = 4.0

    /** The wait, in milliseconds, after [minutes] of social media today. */
    fun delayMs(minutes: Double, timing: ProgressiveBoredomTracker.PhaseThresholds): Long {
        val points = listOf(
            0.0 to AT_START,
            timing.normal to AT_NORMAL_END,
            timing.reduced to AT_REDUCED_END,
            timing.windDown to AT_WIND_DOWN_END,
        )
        val after = points.indexOfFirst { minutes < it.first }
        val seconds = when (after) {
            -1 -> AT_WIND_DOWN_END // past the last boundary: stays there
            0 -> AT_START
            else -> {
                val (fromMinutes, fromSeconds) = points[after - 1]
                val (toMinutes, toSeconds) = points[after]
                fromSeconds + (toSeconds - fromSeconds) * (minutes - fromMinutes) / (toMinutes - fromMinutes)
            }
        }
        return (seconds * 1000).toLong()
    }
}
