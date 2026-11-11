package lol.tolerance.android.service

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Choreographer
import android.view.View
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sign

/**
 * A ruler down the right edge that moves with the content, so you can feel how far you're
 * scrolling while everything is covered. Used as the scroll scrim (with a background), and
 * as a transparent debug overlay over live content.
 *
 * Minor ticks every quarter screen, a numbered major tick per screen.
 *
 * ## Tracking
 *
 * Motion comes from TYPE_VIEW_SCROLLED's ScrollY, ~10Hz with no deltas. Compose's lazy lists
 * *estimate* ScrollY (item index × average height + offset), so whenever the first visible
 * item changes the estimate jumps by that item's error — one-off level shifts of up to ~1000px,
 * in either direction, plus some readings that alternate around the true value.
 *
 * Where a [ContentTracker] is available, [onContentMoved] supplies true movement (~30Hz while
 * moving) and ScrollY is ignored for the rest of the gesture. ScrollY is the fallback:
 *
 * Each reading is the content position *now*, so between readings we extrapolate forward from
 * the last accepted one at the current speed, and ease the drawn ruler toward that.
 * Readings that disagree with the prediction are treated as re-estimates and replaced by it,
 * unless two in a row miss on the same side — then the speed really changed (drag → fling).
 * A real reversal passes through low speed, where the tolerance band covers it, so there's
 * no explicit direction logic to misfire.
 *
 * @param showRaw also draw red ticks from unfiltered ScrollY, snapping per reading, and log
 *   every filter decision — for telling X's data apart from this filter
 */
class ScrollRulerView(context: Context, private val showRaw: Boolean = false) : View(context) {

    private val choreographer = Choreographer.getInstance()

    // Filtered content position (px) as of the last reading, and its uptime
    private var positionPx = 0f
    private var positionUptimeMs = 0L
    private var velocityPxPerMs = 0f
    private var hasVelocity = false

    // What's drawn: eases toward the extrapolated position
    private var drawnPx = 0f
    private var rawPx = 0f

    // Last two readings this gesture, for single and two-step deltas
    private var lastScrollY: Int? = null
    private var lastDelta: Float? = null
    private var lastEventTimeMs = 0L
    private var missedSide = 0 // sign of the previous rejected reading's miss, 0 if accepted

    // Measured movement this gesture (ContentTracker) — when true, ScrollY is ignored
    private var measured = false
    private var lastMeasureUptimeMs = 0L

    private var animating = false

    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255)
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255)
        textSize = dp(11f)
        textAlign = Paint.Align.RIGHT
        if (showRaw) setShadowLayer(dp(2f), 0f, 0f, Color.BLACK)
    }
    // Over live content (debug) the ticks need an outline to show on light backgrounds
    private val outlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(160, 0, 0, 0)
        strokeWidth = dp(4f)
        strokeCap = Paint.Cap.ROUND
    }
    private val rawPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(200, 229, 62, 62)
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
    }

    /**
     * New gesture: drop the baseline reading (ScrollY may have been re-estimated since).
     * @param keepOffset keep ticks where they are rather than restarting at zero —
     *   the debug overlay stays pinned to content across gestures
     */
    fun reset(keepOffset: Boolean = false) {
        if (!keepOffset) {
            positionPx = 0f
            drawnPx = 0f
            rawPx = 0f
        } else {
            positionPx = drawnPx
        }
        velocityPxPerMs = 0f
        hasVelocity = false
        lastScrollY = null
        lastDelta = null
        missedSide = 0
        measured = false
        invalidate()
    }

    /** True content movement from [ContentTracker]: positive = content moved up. */
    fun onContentMoved(deltaPx: Int, uptimeMs: Long) {
        val dt = (uptimeMs - lastMeasureUptimeMs).coerceIn(MIN_MEASURE_DT_MS, MAX_MEASURE_DT_MS).toFloat()
        lastMeasureUptimeMs = uptimeMs
        val speed = deltaPx / dt
        velocityPxPerMs = if (measured) (velocityPxPerMs + speed) / 2f else speed
        measured = true

        positionPx += deltaPx
        positionUptimeMs = uptimeMs
        startAnimating()
    }

    fun onScrollY(scrollY: Int, eventTimeMs: Long) {
        if (scrollY < 0) return // platform doesn't report it
        val now = SystemClock.uptimeMillis()
        val prev = lastScrollY
        val dt = (eventTimeMs - lastEventTimeMs).coerceAtLeast(1L).toFloat()
        lastScrollY = scrollY
        lastEventTimeMs = eventTimeMs
        if (prev == null) {
            // First reading of a gesture is only a baseline
            positionUptimeMs = now
            return
        }

        val delta = (scrollY - prev).toFloat()
        rawPx += delta
        if (measured) {
            if (showRaw) invalidate()
            return
        }
        val twoStep = lastDelta?.let { (it + delta) / 2f }
        lastDelta = delta

        // The first step of a gesture can itself be a re-estimate (layout settled since the
        // last gesture); too fast to be real means it is — re-baseline instead
        if (!hasVelocity && abs(delta) / dt > MAX_FIRST_SPEED_PX_PER_MS) {
            lastDelta = null
            positionUptimeMs = now
            if (showRaw) Log.d(TAG, "y=$scrollY raw=${delta.toInt()} (re-baseline)")
            return
        }

        val accepted: Float
        val why: String
        if (!hasVelocity) {
            accepted = delta
            why = "first"
            hasVelocity = true
        } else {
            val predicted = velocityPxPerMs * dt
            val tolerance = max(MIN_TOLERANCE_PX, abs(predicted) * TOLERANCE_RATIO)
            val miss = delta - predicted
            when {
                abs(miss) <= tolerance -> {
                    accepted = delta; why = "ok"; missedSide = 0
                }
                // Readings alternating around the truth average out over two steps
                twoStep != null && abs(twoStep - predicted) <= tolerance -> {
                    accepted = twoStep; why = "2-step"; missedSide = 0
                }
                // Second miss on the same side: the speed really changed
                missedSide != 0 && sign(miss).toInt() == missedSide -> {
                    accepted = twoStep ?: delta; why = "speed change"; missedSide = 0
                }
                else -> {
                    accepted = predicted; why = "re-estimate"; missedSide = sign(miss).toInt()
                }
            }
        }

        // The accepted step lands about where extrapolation was already heading, so the
        // target stays continuous; easing absorbs whatever difference remains
        positionPx += accepted
        positionUptimeMs = now
        velocityPxPerMs = accepted / dt

        if (showRaw) {
            Log.d(TAG, "y=$scrollY raw=${delta.toInt()} 2step=${twoStep?.toInt()} " +
                "accepted=${accepted.toInt()} ($why) v=${"%.2f".format(velocityPxPerMs)}px/ms")
            invalidate()
        }
        startAnimating()
    }

    /** Where the content should be now: last accepted position plus bounded extrapolation. */
    private fun targetPx(now: Long): Float {
        // Measured reads come ~3x as often and are exact, so look less far ahead
        val horizon = if (measured) MEASURED_EXTRAPOLATION_MS else MAX_EXTRAPOLATION_MS
        val sinceReading = (now - positionUptimeMs).coerceIn(0L, horizon)
        return positionPx + velocityPxPerMs * sinceReading
    }

    private fun startAnimating() {
        if (animating) return
        animating = true
        choreographer.postFrameCallback(frameCallback)
    }

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!animating) return
            val target = targetPx(SystemClock.uptimeMillis())
            drawnPx += (target - drawnPx) * EASE_PER_FRAME
            invalidate()

            val idle = SystemClock.uptimeMillis() - positionUptimeMs > MAX_EXTRAPOLATION_MS
            if (idle && abs(target - drawnPx) < 0.5f) {
                drawnPx = target
                animating = false
                return
            }
            choreographer.postFrameCallback(this)
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animating = false
        choreographer.removeFrameCallback(frameCallback)
    }

    /** False draws a plain scrim: paging feeds (TikTok) move a whole screen per swipe. */
    var rulerVisible = true
        set(value) {
            if (field != value) { field = value; invalidate() }
        }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!rulerVisible) return
        val right = width - dp(10f)
        drawTicks(canvas, drawnPx, right, tickPaint, labels = true)
        if (showRaw) drawTicks(canvas, rawPx, right - dp(24f), rawPaint, labels = false)
    }

    private fun drawTicks(canvas: Canvas, offset: Float, right: Float, paint: Paint, labels: Boolean) {
        val spacing = resources.displayMetrics.heightPixels.toFloat() / TICKS_PER_SCREEN

        // First tick at or above the top edge
        var index = floor(offset / spacing).toInt()
        var y = index * spacing - offset
        while (y < height + spacing) {
            val major = Math.floorMod(index, TICKS_PER_SCREEN) == 0
            val length = dp(if (major) 18f else 9f)
            if (showRaw) canvas.drawLine(right - length, y, right, y, outlinePaint)
            canvas.drawLine(right - length, y, right, y, paint)
            if (labels && major && index != 0) {
                canvas.drawText(abs(index / TICKS_PER_SCREEN).toString(), right - length - dp(6f), y + dp(4f), labelPaint)
            }
            y += spacing
            index++
        }
    }

    private fun dp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    companion object {
        private const val TAG = "Tolerance.Ruler"
        private const val TICKS_PER_SCREEN = 4
        // A reading within this of the prediction is real motion: the larger of a fixed band
        // (slow drags, reversals) and a fraction of the predicted step (flings)
        private const val MIN_TOLERANCE_PX = 150f
        private const val TOLERANCE_RATIO = 0.6f
        // Faster than any first step we've measured (~2.5–4.8 px/ms)
        private const val MAX_FIRST_SPEED_PX_PER_MS = 7f
        // X sends readings every 102–113ms; past ~1.5 intervals the list has stopped
        private const val MAX_EXTRAPOLATION_MS = 160L
        // One tracker read interval: a still read then cancels any overshoot
        private const val MEASURED_EXTRAPOLATION_MS = 33L
        private const val MIN_MEASURE_DT_MS = 16L
        private const val MAX_MEASURE_DT_MS = 150L
        // Fraction of the gap to the target closed each frame (~60% in 3 frames)
        private const val EASE_PER_FRAME = 0.3f
    }
}
