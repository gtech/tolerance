package lol.tolerance.android.boredom

/**
 * One-slider strictness, ported from the extension's src/shared/constants.ts
 * (STRICTNESS_PRESETS). Each level sets the blur threshold for all four phases.
 *
 * Thresholds are on the extension's 0-100 scale (model score × 10): a post is covered when
 * score × 10 ≥ threshold. At 100 only 10s are covered — ads and hidden topics.
 */
object Strictness {

    data class Thresholds(val normal: Int, val reduced: Int, val windDown: Int, val minimal: Int) {
        fun forPhase(phase: ProgressiveBoredomTracker.Phase): Int = when (phase) {
            ProgressiveBoredomTracker.Phase.NORMAL -> normal
            ProgressiveBoredomTracker.Phase.REDUCED -> reduced
            ProgressiveBoredomTracker.Phase.WIND_DOWN -> windDown
            ProgressiveBoredomTracker.Phase.MINIMAL -> minimal
        }
    }

    data class Preset(val label: String, val thresholds: Thresholds)

    // Set from day-to-day use of the extension (2026-11-08)
    val PRESETS = listOf(
        Preset("Very gentle", Thresholds(100, 65, 65, 65)),
        Preset("Gentle", Thresholds(100, 65, 55, 55)),
        Preset("Default", Thresholds(100, 55, 45, 45)),
        Preset("Strict", Thresholds(55, 45, 45, 45)),
        Preset("Very strict", Thresholds(45, 45, 45, 35)),
    )

    const val DEFAULT_LEVEL = 3
    // Top of the scale: only 10s are covered
    const val MAX_THRESHOLD = 100

    /** Level 1 (gentlest) to 5 (strictest). */
    fun preset(level: Int): Preset = PRESETS[level.coerceIn(1, PRESETS.size) - 1]

    fun isCovered(score: Int, threshold: Int): Boolean = score * 10 >= threshold
}
