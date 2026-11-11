package lol.tolerance.android.service

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sign

class ScrollCurvesTest {

    @Before
    fun setup() {
        // Pixel 4 density ≈ 2.75
        ScrollCurves.initForTest(density = 2.75f)
    }

    // ── frameworkCurve ──────────────────────────────────────────────

    @Test
    fun `frameworkCurve returns 0 for zero velocity`() {
        assertEquals(0f, ScrollCurves.frameworkCurve(0f, 100f), 0.01f)
    }

    @Test
    fun `frameworkCurve returns 0 at elapsed 0`() {
        assertEquals(0f, ScrollCurves.frameworkCurve(2f, 0f), 0.01f)
    }

    @Test
    fun `frameworkCurve sign matches velocity sign`() {
        val positive = ScrollCurves.frameworkCurve(1.5f, 80f)
        val negative = ScrollCurves.frameworkCurve(-1.5f, 80f)
        assertTrue("positive velocity should give positive offset", positive > 0f)
        assertTrue("negative velocity should give negative offset", negative < 0f)
        assertEquals("magnitude should match", abs(positive), abs(negative), 0.01f)
    }

    @Test
    fun `frameworkCurve offset increases with elapsed time`() {
        val v = 2.0f
        val at50 = abs(ScrollCurves.frameworkCurve(v, 50f))
        val at100 = abs(ScrollCurves.frameworkCurve(v, 100f))
        val at200 = abs(ScrollCurves.frameworkCurve(v, 200f))
        assertTrue("offset at 100ms > offset at 50ms", at100 > at50)
        assertTrue("offset at 200ms > offset at 100ms", at200 > at100)
    }

    @Test
    fun `frameworkCurve higher velocity gives larger offset`() {
        val slow = abs(ScrollCurves.frameworkCurve(0.5f, 100f))
        val fast = abs(ScrollCurves.frameworkCurve(3.0f, 100f))
        assertTrue("3.0 px/ms should produce larger offset than 0.5 px/ms", fast > slow)
    }

    @Test
    fun `frameworkCurve decelerates over time`() {
        // The rate of change should decrease (deceleration)
        val v = 2.0f
        val delta0to50 = abs(ScrollCurves.frameworkCurve(v, 50f))
        val delta50to100 = abs(ScrollCurves.frameworkCurve(v, 100f)) - delta0to50
        assertTrue("second 50ms should cover less distance (deceleration)", delta50to100 < delta0to50)
    }

    // ── candidateCurve ─────────────────────────────────────────────

    @Test
    fun `candidateCurve returns 0 for zero velocity`() {
        assertEquals(0f, ScrollCurves.candidateCurve(0f, 0f, 100f), 0.01f)
    }

    @Test
    fun `candidateCurve matches framework when not decelerating`() {
        // Same velocity for prev and current = ratio 1.0, decel adjust is identity
        val v = 1.0f
        val fw = ScrollCurves.frameworkCurve(v, 100f)
        val cand = ScrollCurves.candidateCurve(v, v, 100f)
        assertEquals("should match framework at steady velocity", fw, cand, 1f)
    }

    @Test
    fun `candidateCurve reduces offset during deceleration`() {
        // prevV > currV = decelerating, candidate should predict less than framework
        val currV = 1.0f
        val prevV = 2.0f
        val fw = abs(ScrollCurves.frameworkCurve(currV, 100f))
        val cand = abs(ScrollCurves.candidateCurve(currV, prevV, 100f))
        assertTrue("candidate should predict less during decel, fw=$fw cand=$cand", cand < fw)
    }

    // ── transformDecelAdjust ───────────────────────────────────────

    @Test
    fun `decelAdjust returns input when prev velocity too small`() {
        val result = ScrollCurves.transformDecelAdjust(1.0f, 0.01f)
        assertEquals(1.0f, result, 0.001f)
    }

    @Test
    fun `decelAdjust returns input on direction change`() {
        val result = ScrollCurves.transformDecelAdjust(1.0f, -1.0f)
        assertEquals(1.0f, result, 0.001f)
    }

    @Test
    fun `decelAdjust reduces velocity during deceleration`() {
        // Decelerating: current < previous, ratio < 1
        val result = ScrollCurves.transformDecelAdjust(1.0f, 2.0f)
        assertTrue("should reduce velocity, got $result", result < 1.0f)
        assertTrue("should stay positive", result > 0f)
    }

    @Test
    fun `decelAdjust increases velocity during acceleration`() {
        // Accelerating: current > previous, ratio > 1
        val result = ScrollCurves.transformDecelAdjust(2.0f, 1.0f)
        assertTrue("should increase velocity, got $result", result > 2.0f)
    }

    @Test
    fun `decelAdjust clamps ratio to bounds`() {
        // Extreme deceleration: ratio would be 0.1, clamped to 0.3
        val result = ScrollCurves.transformDecelAdjust(0.1f, 1.0f)
        assertEquals(0.1f * 0.3f, result, 0.001f)

        // Extreme acceleration: ratio would be 10, clamped to 1.5
        val result2 = ScrollCurves.transformDecelAdjust(5.0f, 0.5f)
        assertEquals(5.0f * 1.5f, result2, 0.001f)
    }

    // ── transformCap ───────────────────────────────────────────────

    @Test
    fun `cap clamps large offsets when enabled`() {
        ScrollCurves.enableCap = true
        ScrollCurves.capPx = 50f
        assertEquals(50f, ScrollCurves.transformCap(200f), 0.01f)
        assertEquals(-50f, ScrollCurves.transformCap(-200f), 0.01f)
        assertEquals(30f, ScrollCurves.transformCap(30f), 0.01f)
        ScrollCurves.enableCap = false
    }

    @Test
    fun `cap is identity when disabled`() {
        ScrollCurves.enableCap = false
        assertEquals(200f, ScrollCurves.transformCap(200f), 0.01f)
    }

    // ── Follow-curve formula ───────────────────────────────────────
    // Tests for: step = sign(error) * K * error² / (|error| + C)

    private fun followStep(error: Float, k: Float = 0.6f, c: Float = 50f): Float {
        if (abs(error) < 0.5f) return error
        return error.sign * k * error * error / (abs(error) + c)
    }

    @Test
    fun `follow curve step is zero for zero error`() {
        assertEquals(0f, followStep(0f), 0.001f)
    }

    @Test
    fun `follow curve step sign matches error sign`() {
        assertTrue(followStep(100f) > 0f)
        assertTrue(followStep(-100f) < 0f)
    }

    @Test
    fun `follow curve larger error gives larger step`() {
        val small = abs(followStep(20f))
        val large = abs(followStep(200f))
        assertTrue("200px error should produce larger step than 20px, small=$small large=$large", large > small)
    }

    @Test
    fun `follow curve step is always less than error`() {
        // The curve should never overshoot in a single frame
        for (error in listOf(1f, 10f, 50f, 100f, 500f, 1000f)) {
            val step = abs(followStep(error))
            assertTrue("step ($step) should be less than error ($error)", step < error)
        }
    }

    @Test
    fun `follow curve makes consistent progress`() {
        // Each step should reduce the error
        var error = 200f
        for (i in 0 until 10) {
            val step = followStep(error)
            val newError = error - step
            assertTrue("step should reduce error (error=$error step=$step)", abs(newError) < abs(error))
            error = newError
        }
    }

    @Test
    fun `follow curve closes most of a 200px gap within 6 frames`() {
        // Events arrive every ~6 frames (100ms at 60fps).
        // The curve should close the majority of a large gap quickly
        // even if the tail is slow (the next event will update realY).
        var smoothedY = 0f
        val targetY = 200f
        for (i in 0 until 6) {
            val error = targetY - smoothedY
            smoothedY += followStep(error)
        }
        val closed = smoothedY / targetY
        assertTrue("should close >80%% of 200px gap in 6 frames (closed ${(closed * 100).toInt()}%%)", closed > 0.8f)
    }

    @Test
    fun `follow curve slow tail for small errors`() {
        // Known behavior: quadratic numerator means error²/C is tiny for small errors.
        // At error=5px, step ≈ 0.6 * 25 / 55 ≈ 0.27px/frame — very slow.
        // This documents the behavior; a min-step or linear blend may be needed.
        val step = followStep(5f)
        assertTrue("small-error step should be positive but small (got $step)", step > 0f && step < 1f)
    }

    @Test
    fun `follow curve K controls responsiveness`() {
        val slowStep = abs(followStep(100f, k = 0.3f))
        val fastStep = abs(followStep(100f, k = 0.9f))
        assertTrue("higher K should produce larger step", fastStep > slowStep)
    }

    @Test
    fun `follow curve C controls crossover`() {
        // Higher C = gentler curve (smaller steps for same error)
        val lowC = abs(followStep(100f, c = 20f))
        val highC = abs(followStep(100f, c = 200f))
        assertTrue("higher C should produce smaller step", lowC > highC)
    }
}
