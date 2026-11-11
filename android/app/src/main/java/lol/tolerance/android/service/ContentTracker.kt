package lol.tolerance.android.service

import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Measures how far feed content actually moved, by re-reading one post's on-screen position
 * (the "anchor") when the app reports changes.
 *
 * Scroll events alone aren't enough: X's ScrollY is an estimate that jumps at item
 * boundaries, and when its header slides in the content moves with no scroll event at all —
 * only TYPE_WINDOW_CONTENT_CHANGED. A node's bounds are the truth either way.
 *
 * Each read is one IPC served on the target app's UI thread, so reads are coalesced and
 * rate-limited, and run on a dedicated thread so they never block our overlay drawing.
 * Compose clips node bounds to the list's viewport, so an edge that has scrolled out of view
 * stops moving: movement is measured from whichever edge is still inside, and a post taller
 * than the viewport (both edges clipped) can't be an anchor. The anchor is swapped for the
 * list child nearest mid-screen *before* it scrolls away, so no movement is lost.
 *
 * While content is moving, reads continue every MIN_READ_INTERVAL_MS on their own (events
 * only arrive ~10Hz during a fling); the first read that finds it still ends that.
 *
 * @param onMoved called on the main thread after every read with content movement in px
 *   (positive = content moved up, i.e. the user scrolled down; 0 = still) and the read's uptime
 */
class ContentTracker(
    private val screenHeight: Int,
    private val onMoved: (deltaPx: Int, uptimeMs: Long) -> Unit,
) {
    private val thread = HandlerThread("Tolerance.Tracker").apply { start() }
    private val tracker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private val readQueued = AtomicBoolean(false)

    // Tracker thread only
    private var anchor: AccessibilityNodeInfo? = null
    private var anchorTop = 0
    private var anchorBottom = 0
    // The anchor's list bounds — node bounds are clipped to this
    private val viewport = Rect(0, 0, 0, screenHeight)
    private var lastReadUptime = 0L
    private var statReads = 0
    private var statTotalMs = 0L
    private var statMaxMs = 0L

    /** Candidate anchors from an identify pass (on-screen post containers). Any thread. */
    fun setCandidates(nodes: List<AccessibilityNodeInfo>) {
        tracker.post { anchorTo(nodes) }
    }

    /** Something may have moved: read the anchor soon. Coalesced and rate-limited. Any thread. */
    fun requestRead() {
        if (!readQueued.compareAndSet(false, true)) return
        val wait = (lastReadUptime + MIN_READ_INTERVAL_MS - SystemClock.uptimeMillis()).coerceAtLeast(0L)
        tracker.postDelayed({
            readQueued.set(false)
            read()
        }, wait)
    }

    /** Forget the anchor (app switch). Any thread. */
    fun clear() {
        tracker.post { anchor = null }
    }

    fun shutdown() {
        thread.quitSafely()
    }

    private fun read() {
        val node = anchor ?: return
        val t0 = SystemClock.uptimeMillis()
        lastReadUptime = t0

        val alive = try { node.refresh() } catch (_: Exception) { false }
        if (!alive) {
            // Gone before we could switch (very fast fling) — this read's movement is lost
            reanchorFromList(node)
            recordCost(t0)
            requestRead()
            return
        }
        val rect = Rect().also { node.getBoundsInScreen(it) }
        val delta = measure(rect)
        anchorTop = rect.top
        anchorBottom = rect.bottom

        if (delta == null || abs(delta) > screenHeight) {
            // No unclipped edge to measure, or the node was reused for different content
            reanchorFromList(node)
            requestRead()
        } else {
            main.post { onMoved(delta, t0) }
            if (delta != 0) requestRead() // keep sampling while it moves
            // Leaving the viewport: switch while it's still measurable. Short posts fully in
            // view stay as they are, however small.
            val clipped = rect.top <= viewport.top || rect.bottom >= viewport.bottom
            if (clipped && rect.height() < screenHeight * MIN_VISIBLE_FRACTION) reanchorFromList(node)
        }
        recordCost(t0)
    }

    /**
     * Content movement since the last read, from an edge that was inside the viewport both
     * times (positive = moved up). null when neither edge was.
     */
    private fun measure(rect: Rect): Int? {
        val topInside = anchorTop > viewport.top && rect.top > viewport.top
        val bottomInside = anchorBottom < viewport.bottom && rect.bottom < viewport.bottom
        return when {
            topInside -> anchorTop - rect.top
            bottomInside -> anchorBottom - rect.bottom
            else -> null
        }
    }

    /**
     * Pick the measurable candidate nearest mid-screen and take its current bounds as the
     * baseline. Candidates share a list; its bounds become the clipping viewport.
     */
    private fun anchorTo(
        candidates: List<AccessibilityNodeInfo>,
        list: AccessibilityNodeInfo? = null,
        previous: AccessibilityNodeInfo? = null,
    ) {
        val listNode = list ?: candidates.firstOrNull()?.parent
        if (listNode != null) listNode.getBoundsInScreen(viewport) else viewport.set(0, 0, 0, screenHeight)

        val mid = screenHeight / 2
        var best: AccessibilityNodeInfo? = null
        val bestRect = Rect()
        var bestDistance = Int.MAX_VALUE
        val rect = Rect()
        for (node in candidates) {
            val alive = try { node.refresh() } catch (_: Exception) { false }
            if (!alive) continue
            node.getBoundsInScreen(rect)
            if (rect.isEmpty) continue
            if (node == previous) {
                // Movement since the old anchor's last read would otherwise fall into the gap
                // while we scan for its replacement
                measure(rect)?.takeIf { it != 0 && abs(it) <= screenHeight }?.let { delta ->
                    val t = SystemClock.uptimeMillis()
                    main.post { onMoved(delta, t) }
                }
            }
            // Taller than the viewport: neither edge moves visibly
            if (rect.top <= viewport.top && rect.bottom >= viewport.bottom) continue
            val distance = if (mid in rect.top..rect.bottom) 0 else minOf(abs(rect.top - mid), abs(rect.bottom - mid))
            if (distance < bestDistance) {
                best = node; bestRect.set(rect); bestDistance = distance
            }
        }
        anchor = best // null until the next identify pass if nothing is measurable
        anchorTop = bestRect.top
        anchorBottom = bestRect.bottom
    }

    private fun reanchorFromList(old: AccessibilityNodeInfo) {
        val list = old.parent
        if (list == null || !(try { list.refresh() } catch (_: Exception) { false })) {
            anchor = null // wait for the next identify pass
            return
        }
        anchorTo((0 until list.childCount).mapNotNull { list.getChild(it) }, list, previous = old)
    }

    private fun recordCost(t0: Long) {
        val ms = SystemClock.uptimeMillis() - t0
        statReads++
        statTotalMs += ms
        if (ms > statMaxMs) statMaxMs = ms
        if (statReads == STATS_EVERY) {
            Log.d(TAG, "$statReads reads: avg ${"%.1f".format(statTotalMs.toFloat() / statReads)}ms, max ${statMaxMs}ms")
            statReads = 0; statTotalMs = 0; statMaxMs = 0
        }
    }

    companion object {
        private const val TAG = "Tolerance.Tracker"
        // ~30 reads/s at most: each is an IPC on the target app's UI thread
        private const val MIN_READ_INTERVAL_MS = 33L
        // Swap a partly scrolled-out anchor once less than this much of the screen shows it
        private const val MIN_VISIBLE_FRACTION = 0.15f
        private const val STATS_EVERY = 50
    }
}
