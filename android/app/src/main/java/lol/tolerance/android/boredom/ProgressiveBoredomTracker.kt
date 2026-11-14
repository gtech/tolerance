package lol.tolerance.android.boredom

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Tracks social media usage time and manages progressive boredom phases.
 * Ported from extension/src/background/storage.ts global session logic.
 *
 * Phases (default timing), each with a blur threshold from the [Strictness] preset:
 * - Normal (0-15 min): baseline — at Default strictness only 10s (ads, hidden topics)
 * - Reduced (15-45 min): quick hits blurred
 * - Wind-down (45-75 min): more blurred
 * - Minimal (75+ min): most cheap-payoff content blurred
 *
 * Time is tracked via accessibility event activity — the service knows when
 * social apps are active, so no heartbeat timer is needed.
 */
class ProgressiveBoredomTracker(private val context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("tolerance_boredom", Context.MODE_PRIVATE)

    private var lastActivityTimestamp = System.currentTimeMillis()
    private var lastNotifiedPhase: Phase = Phase.NORMAL

    enum class Phase(val label: String) {
        NORMAL("normal"),
        REDUCED("reduced"),
        WIND_DOWN("wind-down"),
        MINIMAL("minimal"),
    }

    /**
     * Record social media activity. Called on each accessibility event.
     * Adds elapsed time if within the activity gap threshold.
     */
    fun recordActivity() {
        val now = System.currentTimeMillis()
        val elapsed = now - lastActivityTimestamp

        // Only count continuous activity (gap < 2 minutes)
        if (elapsed in 1..ACTIVITY_GAP_THRESHOLD_MS) {
            val minutesToAdd = elapsed / 60_000.0
            val current = getTotalMinutes()
            setTotalMinutes(current + minutesToAdd)
        }

        lastActivityTimestamp = now

        // Check for phase transition
        val phase = getCurrentPhase()
        if (phase != lastNotifiedPhase) {
            onPhaseChanged(lastNotifiedPhase, phase)
            lastNotifiedPhase = phase
        }
    }

    /** Off: the day never leaves Normal, so only the Normal threshold applies. */
    fun getCurrentPhase(): Phase {
        if (!isEnabled()) return Phase.NORMAL
        val minutes = getTotalMinutes()
        val thresholds = getPhaseThresholds()
        return when {
            minutes >= thresholds.windDown -> Phase.MINIMAL
            minutes >= thresholds.reduced -> Phase.WIND_DOWN
            minutes >= thresholds.normal -> Phase.REDUCED
            else -> Phase.NORMAL
        }
    }

    /**
     * The current blur threshold on the extension's 0-100 scale: a post is covered when
     * score × 10 is at or above it (see [Strictness.isCovered]).
     */
    fun getCurrentBlurThreshold(): Int =
        Strictness.preset(getStrictness()).thresholds.forPhase(getCurrentPhase())

    /** 1 (gentlest) to 5 (strictest). */
    fun getStrictness(): Int = prefs.getInt(KEY_STRICTNESS, Strictness.DEFAULT_LEVEL)

    fun setStrictness(level: Int) {
        prefs.edit().putInt(KEY_STRICTNESS, level.coerceIn(1, Strictness.PRESETS.size)).apply()
    }

    /** Today's minutes: yesterday's count is cleared first, so Settings never shows it. */
    fun getTotalMinutes(): Double {
        ensureDailyReset()
        return prefs.getFloat(KEY_TOTAL_MINUTES, 0f).toDouble()
    }

    private fun setTotalMinutes(minutes: Double) {
        prefs.edit().putFloat(KEY_TOTAL_MINUTES, minutes.toFloat()).apply()
    }

    fun isEnabled(): Boolean =
        prefs.getBoolean(KEY_ENABLED, true)

    fun setEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    data class PhaseThresholds(
        val normal: Double,
        val reduced: Double,
        val windDown: Double,
    )

    fun getPhaseThresholds(): PhaseThresholds {
        return PhaseThresholds(
            normal = prefs.getFloat(KEY_THRESHOLD_NORMAL, DEFAULT_NORMAL_MINUTES.toFloat()).toDouble(),
            reduced = prefs.getFloat(KEY_THRESHOLD_REDUCED, DEFAULT_REDUCED_MINUTES.toFloat()).toDouble(),
            windDown = prefs.getFloat(KEY_THRESHOLD_WIND_DOWN, DEFAULT_WIND_DOWN_MINUTES.toFloat()).toDouble(),
        )
    }

    fun setPhaseThresholds(thresholds: PhaseThresholds) {
        prefs.edit()
            .putFloat(KEY_THRESHOLD_NORMAL, thresholds.normal.toFloat())
            .putFloat(KEY_THRESHOLD_REDUCED, thresholds.reduced.toFloat())
            .putFloat(KEY_THRESHOLD_WIND_DOWN, thresholds.windDown.toFloat())
            .apply()
    }

    /**
     * Reset daily session if the date has changed.
     * Resets at 4am to accommodate late-night users.
     */
    private fun ensureDailyReset() {
        val today = getTodayDateString()
        val storedDate = prefs.getString(KEY_RESET_DATE, null)
        if (storedDate != today) {
            Log.d(TAG, "Daily reset: $storedDate -> $today (${prefs.getFloat(KEY_TOTAL_MINUTES, 0f)} min)")
            prefs.edit()
                .putString(KEY_RESET_DATE, today)
                .putFloat(KEY_TOTAL_MINUTES, 0f)
                .putString(KEY_MAX_PHASE, Phase.NORMAL.label)
                .apply()
            lastNotifiedPhase = Phase.NORMAL
        }
    }

    private fun onPhaseChanged(from: Phase, to: Phase) {
        Log.d(TAG, "Phase transition: ${from.label} -> ${to.label} at ${getTotalMinutes()} min")

        // Update max phase reached
        val maxPhase = prefs.getString(KEY_MAX_PHASE, Phase.NORMAL.label) ?: Phase.NORMAL.label
        val phaseOrder = Phase.entries.map { it.label }
        if (phaseOrder.indexOf(to.label) > phaseOrder.indexOf(maxPhase)) {
            prefs.edit().putString(KEY_MAX_PHASE, to.label).apply()
        }
        // No notification: the phase shows in settings, and being told mid-scroll was more
        // annoying than useful
    }

    companion object {
        private const val TAG = "Tolerance.Boredom"
        private const val ACTIVITY_GAP_THRESHOLD_MS = 2 * 60 * 1000L // 2 minutes

        // Default phase thresholds (minutes) — matching extension
        const val DEFAULT_NORMAL_MINUTES = 15.0
        const val DEFAULT_REDUCED_MINUTES = 45.0
        const val DEFAULT_WIND_DOWN_MINUTES = 75.0

        // SharedPreferences keys
        private const val KEY_TOTAL_MINUTES = "total_minutes"
        private const val KEY_RESET_DATE = "reset_date"
        private const val KEY_MAX_PHASE = "max_phase"
        private const val KEY_ENABLED = "boredom_enabled"
        private const val KEY_STRICTNESS = "strictness"
        private const val KEY_THRESHOLD_NORMAL = "threshold_normal"
        private const val KEY_THRESHOLD_REDUCED = "threshold_reduced"
        private const val KEY_THRESHOLD_WIND_DOWN = "threshold_wind_down"

        /**
         * Get today's date string, with 4am reset boundary.
         */
        private fun getTodayDateString(): String {
            val now = Date()
            val cal = java.util.Calendar.getInstance().apply { time = now }
            // Before 4am counts as previous day
            if (cal.get(java.util.Calendar.HOUR_OF_DAY) < 4) {
                cal.add(java.util.Calendar.DAY_OF_MONTH, -1)
            }
            return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
        }
    }
}
