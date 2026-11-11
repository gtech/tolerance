package lol.tolerance.android.service

import android.content.Context
import android.hardware.SensorManager
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sign

/**
 * Two scroll prediction models:
 * 1. frameworkCurve — exact AOSP SplineOverScroller reproduction
 * 2. candidateCurve — composable pipeline of transforms we can toggle/tune
 *
 * Both take (velocity in px/ms, elapsed in ms) → predicted offset in px.
 */
object ScrollCurves {

    // ──────────────────────────────────────────────
    // AOSP SplineOverScroller constants
    // ──────────────────────────────────────────────
    private const val DECELERATION_RATE = 2.3582018f
    private const val INFLEXION = 0.35f
    private const val START_TENSION = 0.5f
    private const val END_TENSION = 1.0f
    private const val P1 = START_TENSION * INFLEXION
    private const val P2 = 1.0f - END_TENSION * (1.0f - INFLEXION)
    private const val NB_SAMPLES = 100
    private const val SCROLL_FRICTION = 0.015f

    private val SPLINE_POSITION = FloatArray(NB_SAMPLES + 1)
    private var physicalCoeff = 0f

    init {
        var xMin = 0.0f
        for (i in 0 until NB_SAMPLES) {
            val alpha = i.toFloat() / NB_SAMPLES
            var xMax = 1.0f
            var x: Float; var tx: Float; var coef: Float
            while (true) {
                x = xMin + (xMax - xMin) / 2.0f
                coef = 3.0f * x * (1.0f - x)
                tx = coef * ((1.0f - x) * P1 + x * P2) + x * x * x
                if (abs(tx - alpha) < 1E-5) break
                if (tx > alpha) xMax = x else xMin = x
            }
            SPLINE_POSITION[i] = coef * ((1.0f - x) * START_TENSION + x) + x * x * x
        }
        SPLINE_POSITION[NB_SAMPLES] = 1.0f
    }

    fun init(context: Context) {
        val ppi = context.resources.displayMetrics.density * 160.0f
        physicalCoeff = SensorManager.GRAVITY_EARTH * 39.37f * ppi * 0.84f
    }

    /** For unit tests — set physicalCoeff directly without a Context. */
    fun initForTest(density: Float = 2.75f) {
        val ppi = density * 160.0f
        physicalCoeff = 9.80665f * 39.37f * ppi * 0.84f
    }

    // ──────────────────────────────────────────────
    // Shared: AOSP spline evaluation
    // ──────────────────────────────────────────────

    /**
     * Core AOSP spline evaluation. Given velocity (px/ms) and elapsed time (ms),
     * returns predicted offset in px using the SplineOverScroller curve.
     */
    private fun splineOffset(velocityPxPerMs: Float, elapsedMs: Float): Float {
        if (physicalCoeff == 0f || abs(velocityPxPerMs) < 0.01f) return 0f

        val velocityPxPerSec = velocityPxPerMs * 1000f
        val sign = velocityPxPerSec.sign

        val l = ln(INFLEXION * abs(velocityPxPerSec) / (SCROLL_FRICTION * physicalCoeff).toDouble())
        val decelMinusOne = (DECELERATION_RATE - 1.0).toDouble()
        val totalDistance = SCROLL_FRICTION * physicalCoeff *
                exp(DECELERATION_RATE / decelMinusOne * l).toFloat()
        val durationMs = (1000.0 * exp(l / decelMinusOne)).toFloat()

        if (durationMs <= 0f) return 0f

        val t = (elapsedMs / durationMs).coerceIn(0f, 1f)
        val index = (NB_SAMPLES * t).toInt().coerceAtMost(NB_SAMPLES - 1)
        val tInf = index.toFloat() / NB_SAMPLES
        val tSup = (index + 1).toFloat() / NB_SAMPLES
        val dInf = SPLINE_POSITION[index]
        val dSup = SPLINE_POSITION[index + 1]
        val distanceCoef = dInf + (t - tInf) / (tSup - tInf) * (dSup - dInf)

        return sign * totalDistance * distanceCoef
    }

    // ──────────────────────────────────────────────
    // Framework curve: raw AOSP spline, no transforms
    // ──────────────────────────────────────────────

    fun frameworkCurve(velocityPxPerMs: Float, elapsedMs: Float): Float {
        return splineOffset(velocityPxPerMs, elapsedMs)
    }

    // ──────────────────────────────────────────────
    // Candidate curve: composable transform pipeline
    // Each transform is a separate helper that can be toggled.
    // ──────────────────────────────────────────────

    // Toggle each transform on/off
    var enableDecelAdjust = true     // adjust velocity based on deceleration trend
    var enableVelocityScale = false  // static scale factor
    var enableCap = false            // hard cap on offset

    // Tunable parameters
    var velocityScale = 1.0f         // static scale (only if enableVelocityScale)
    var capPx = 80f                  // max offset in px (only if enableCap)

    /**
     * Transform: deceleration-aware velocity adjustment.
     *
     * The measured velocity is an average over the previous ~100ms. During
     * deceleration, the instantaneous velocity at prediction start is lower.
     * If we know the velocity ratio between consecutive frames, we can
     * project one more step of that deceleration:
     *
     *   v_adjusted = v_curr * (v_curr / v_prev) = v_curr² / v_prev
     *
     * During steady scroll: ratio ≈ 1.0, no change.
     * During deceleration: ratio < 1.0, velocity reduced.
     * During acceleration: ratio > 1.0, velocity increased (clamped).
     *
     * @param velocity current smoothed velocity (px/ms)
     * @param prevVelocity velocity from the previous frame (px/ms)
     * @return adjusted velocity
     */
    fun transformDecelAdjust(velocity: Float, prevVelocity: Float): Float {
        if (!enableDecelAdjust) return velocity
        if (abs(prevVelocity) < 0.05f) return velocity
        // Same-direction check
        if (velocity * prevVelocity <= 0f) return velocity
        val ratio = (velocity / prevVelocity).coerceIn(0.3f, 1.5f)
        return velocity * ratio
    }

    /**
     * Transform: static velocity scale factor.
     * Simple multiplier to globally reduce/increase prediction aggressiveness.
     */
    fun transformVelocityScale(v: Float): Float {
        return if (enableVelocityScale) v * velocityScale else v
    }

    /**
     * Transform: cap maximum offset to prevent huge overshoots.
     */
    fun transformCap(offset: Float): Float {
        return if (enableCap) offset.coerceIn(-capPx, capPx) else offset
    }

    /**
     * Candidate prediction: AOSP spline curve + composable transforms.
     *
     * Pipeline: velocity → decel adjust → scale → spline → cap → offset
     *
     * @param velocityPxPerMs current smoothed velocity
     * @param prevVelocityPxPerMs velocity from previous frame (for decel detection)
     * @param elapsedMs time since prediction started
     */
    fun candidateCurve(velocityPxPerMs: Float, prevVelocityPxPerMs: Float, elapsedMs: Float): Float {
        if (abs(velocityPxPerMs) < 0.01f) return 0f
        var v = transformDecelAdjust(velocityPxPerMs, prevVelocityPxPerMs)
        v = transformVelocityScale(v)
        val offset = splineOffset(v, elapsedMs)
        return transformCap(offset)
    }
}
