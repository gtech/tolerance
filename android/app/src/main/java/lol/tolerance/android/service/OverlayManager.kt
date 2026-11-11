package lol.tolerance.android.service

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import lol.tolerance.android.extraction.ScreenBounds
import lol.tolerance.android.scoring.ScoringService

/**
 * Manages TYPE_ACCESSIBILITY_OVERLAY windows. All methods must be called on the main thread.
 *
 * ## Blur-while-scrolling
 *
 * Accessibility events arrive at ~100ms intervals (throttled in the target app, not
 * configurable), so overlays can't track posts during a scroll without visibly lagging.
 * Instead we never track:
 *
 * 1. Scroll starts → beginScroll(): fade the scrim in, then drop all post covers
 * 2. Scroll settles → service extracts posts once, off the main thread
 * 3. render(): place covers at the now-static post bounds, then fade the scrim out
 *
 * Covers and scrim always overlap during handoffs — covers outlive the scrim's fade-in,
 * and are added before its fade-out — so covered content never flashes.
 */
class OverlayManager(private val context: Context) {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    /** What should cover a post once the screen is still. */
    sealed interface Cover {
        val contentHash: String
        val bounds: ScreenBounds

        /** Scored at or above the current blur threshold. */
        data class Scored(
            override val contentHash: String,
            override val bounds: ScreenBounds,
            val score: ScoringService.PostScore,
        ) : Cover

        /** Not scored yet — covered until the score arrives (blur-until-scored). */
        data class Pending(
            override val contentHash: String,
            override val bounds: ScreenBounds,
        ) : Cover

        /** Post whose header is off-screen and that we've never seen whole — scroll up to identify. */
        data class Unidentified(
            override val contentHash: String,
            override val bounds: ScreenBounds,
        ) : Cover

        /** Promoted post, covered because ad blocking is on. */
        data class Ad(
            override val contentHash: String,
            override val bounds: ScreenBounds,
        ) : Cover

        /** Live stream, covered because the user hides LIVE. */
        data class Live(
            override val contentHash: String,
            override val bounds: ScreenBounds,
        ) : Cover

        /** YouTube Shorts (the player or a shelf), covered because the user hides Shorts. */
        data class Shorts(
            override val contentHash: String,
            override val bounds: ScreenBounds,
            val player: Boolean,
        ) : Cover

        /** Labeled AI-generated, covered because the user hides AI content. */
        data class Ai(
            override val contentHash: String,
            override val bounds: ScreenBounds,
        ) : Cover
    }

    private class CoverWindow(
        val cover: Cover,
        val view: View,
        val params: WindowManager.LayoutParams,
    )

    // contentHash → cover window currently on screen
    private val covers = mutableMapOf<String, CoverWindow>()
    // Replaced covers still up until their replacements have drawn
    private val retiring = mutableSetOf<View>()
    private val mainHandler = Handler(Looper.getMainLooper())
    val coverCount: Int get() = covers.size

    private var scrim: ScrollRulerView? = null
    // Identifies the latest scrim show; see showScrim
    private var scrimToken = 0
    private var scoreTag: TextView? = null

    // Transparent ruler over live content, for checking ruler accuracy (Settings → Debug)
    private var debugRuler: ScrollRulerView? = null
    private var scrimParams: WindowManager.LayoutParams? = null

    /**
     * Real blur (Android 12+) when the device and current power state allow it;
     * otherwise the scrim is an opaque cover. Checked per scroll because battery saver
     * and some OEM settings toggle it at runtime.
     */
    private val crossWindowBlurEnabled: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            windowManager.isCrossWindowBlurEnabled

    /**
     * Scroll started: positions are about to go stale, so drop every post cover.
     * @param feedBounds bounds of the scrolling container, or null for full screen
     * @param showScrim false when unscored posts wouldn't be covered anyway (reading screens,
     *   or blur-until-scored off in the Normal phase)
     */
    fun beginScroll(feedBounds: ScreenBounds?, showScrim: Boolean, showRuler: Boolean = true, instant: Boolean = false) {
        debugRuler?.reset(keepOffset = true)
        // The tag belongs to the video scrolling away
        removeScoreTag()
        // Covers stay up (if a little stale) until the scrim is opaque over them
        if (showScrim) showScrim(feedBounds, showRuler, instant, onOpaque = ::removeAllCovers)
        else removeAllCovers()
    }

    /**
     * A small score tag at the screen's left edge, for full-screen feeds (TikTok) where the
     * score of an uncovered video is otherwise invisible. null removes it.
     * @param videoBounds bounds of the video it describes; the tag sits at its left edge
     * @param atTop just under the app's top tabs, rather than 40% of the way down
     */
    fun showScoreTag(text: String?, videoBounds: ScreenBounds?, atTop: Boolean = false) {
        if (text == null || videoBounds == null) {
            removeScoreTag()
            return
        }
        val position = if (atTop) SCORE_TAG_TOP else SCORE_TAG_MIDDLE
        val y = videoBounds.top + ((videoBounds.bottom - videoBounds.top) * position).toInt()
        val existing = scoreTag
        if (existing != null) {
            existing.text = text
            val params = existing.layoutParams as WindowManager.LayoutParams
            if (params.y != y) {
                params.y = y
                try { windowManager.updateViewLayout(existing, params) } catch (_: Exception) { }
            }
            return
        }
        val view = TextView(context).apply {
            this.text = text
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            minWidth = dpToPx(32f).toInt()
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(SCORE_TAG_COLOR)
                // Rounded on the screen side only, so it reads as attached to the edge
                val r = dpToPx(12f)
                cornerRadii = floatArrayOf(0f, 0f, r, r, r, r, 0f, 0f)
            }
            val pad = dpToPx(8f).toInt()
            setPadding(pad, pad / 2, pad, pad / 2)
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = videoBounds.left
            this.y = y
        }
        try {
            windowManager.addView(view, params)
            scoreTag = view
        } catch (e: Exception) {
            Log.w(TAG, "Failed to show score tag", e)
        }
    }

    private fun removeScoreTag() {
        scoreTag?.let { try { windowManager.removeView(it) } catch (_: Exception) { } }
        scoreTag = null
    }

    /** Feed the scroll ruler on the scrim (no-op when no scrim is up). */
    fun onScrollProgress(scrollY: Int, eventTimeMs: Long) {
        scrim?.onScrollY(scrollY, eventTimeMs)
        debugRuler?.onScrollY(scrollY, eventTimeMs)
    }

    /** Feed measured content movement (ContentTracker) to the rulers. */
    fun onContentMoved(deltaPx: Int, uptimeMs: Long) {
        scrim?.onContentMoved(deltaPx, uptimeMs)
        debugRuler?.onContentMoved(deltaPx, uptimeMs)
    }

    /** Show or remove the debug ruler. Idempotent — called on every event. */
    fun setDebugRuler(enabled: Boolean) {
        if (enabled == (debugRuler != null)) return
        if (enabled) {
            val view = ScrollRulerView(context, showRaw = true)
            try {
                windowManager.addView(view, createWindowParams(null))
                debugRuler = view
            } catch (e: Exception) {
                Log.w(TAG, "Failed to show debug ruler", e)
            }
        } else {
            removeDebugRuler()
        }
    }

    private fun removeDebugRuler() {
        debugRuler?.let { try { windowManager.removeView(it) } catch (_: Exception) { } }
        debugRuler = null
    }

    /**
     * Screen is still: make post covers match [next] exactly, then lift the scrim.
     */
    fun render(next: List<Cover>) {
        val nextByHash = next.associateBy { it.contentHash }

        // Covers for posts that are gone or whose state changed (pending → scored)
        val stale = covers.filter { (hash, window) ->
            val wanted = nextByHash[hash]
            wanted == null || wanted::class != window.cover::class || wanted.bounds != window.cover.bounds
        }.values.toList()
        stale.forEach { covers.remove(it.cover.contentHash) }

        val added = next.filter { it.contentHash !in covers }
        // New windows stack on top: drop the score tag so the caller re-adds it above them
        if (added.isNotEmpty()) removeScoreTag()
        val replacements = added.mapNotNull { addCover(it) }

        // Old covers come down only once their replacements are on screen, so the post
        // never shows between the "…" cover and the scored one
        retireOnceDrawn(stale.map { it.view }, replacements)

        hideScrim()
    }

    /**
     * Remove [old] windows after [replacements] have drawn and had time to reach the screen.
     * Covers are opaque, so overlapping for a few frames is invisible; a gap is not.
     */
    private fun retireOnceDrawn(old: List<View>, replacements: List<View>) {
        if (old.isEmpty()) return
        val anchor = replacements.lastOrNull()
        if (anchor == null) {
            old.forEach(::removeWindow)
            return
        }
        retiring.addAll(old)
        whenOnScreen(anchor) {
            old.forEach { if (retiring.remove(it)) removeWindow(it) }
        }
    }

    /**
     * Run [action] once a just-added [view] has drawn and had time to reach the display, or
     * after REPLACE_MAX_WAIT_MS in case it never draws (removed first, or the app hid us).
     */
    private fun whenOnScreen(view: View, action: () -> Unit) {
        var done = false
        val once = Runnable {
            if (!done) {
                done = true
                action()
            }
        }
        view.viewTreeObserver.addOnDrawListener(object : ViewTreeObserver.OnDrawListener {
            private var seen = false
            override fun onDraw() {
                if (seen) return
                seen = true
                // Listeners can't be removed from inside onDraw
                mainHandler.post { view.viewTreeObserver.removeOnDrawListener(this) }
                // onDraw queues the frame; it reaches the display a vsync or two later
                mainHandler.postDelayed(once, REPLACE_OVERLAP_MS)
            }
        })
        mainHandler.postDelayed(once, REPLACE_MAX_WAIT_MS)
    }

    private fun removeWindow(view: View) {
        try { windowManager.removeView(view) } catch (_: Exception) { }
    }

    /** Remove everything. Called on app switch / platform change / service teardown. */
    fun clearAll() {
        Log.i(TAG, "clearAll called, removing ${covers.size} covers")
        removeAllCovers()
        scrim?.let { view ->
            view.animate().cancel()
            try { windowManager.removeView(view) } catch (_: Exception) { }
        }
        scrim = null
        scrimParams = null
        removeDebugRuler()
        removeScoreTag()
    }

    // --- Scrim ---

    /**
     * Fade the scrim in, calling [onOpaque] once it fully covers the feed. A render() that
     * cancels the fade-in also skips [onOpaque] — render replaces the covers itself.
     *
     * @param instant no fade: for paging feeds (TikTok), where the next video slides in at
     *   once and every frame of fade shows it. [onOpaque] then waits for the scrim to draw.
     */
    private fun showScrim(feedBounds: ScreenBounds?, showRuler: Boolean, instant: Boolean, onOpaque: () -> Unit) {
        val existing = scrim
        Log.d(TAG, "Scrim show (${if (existing != null) "reclaim at alpha ${existing.alpha}" else "new"})")
        val token = ++scrimToken
        // render() bumps the token: covers it placed must not be wiped by a late callback
        val opaque = { if (token == scrimToken) onOpaque() }
        if (existing != null) {
            // Still fading out from the last settle — reverse it
            existing.reset()
            existing.rulerVisible = showRuler
            existing.animate().cancel()
            if (instant) {
                existing.alpha = 1f
                whenOnScreen(existing, opaque)
            } else {
                existing.animate().alpha(1f).setDuration(SCRIM_FADE_IN_MS).withEndAction(opaque).start()
            }
            return
        }

        val blur = crossWindowBlurEnabled
        val view = ScrollRulerView(context).apply {
            setBackgroundColor(if (blur) SCRIM_TINT_OVER_BLUR else SCRIM_OPAQUE)
            alpha = if (instant) 1f else 0f
            rulerVisible = showRuler
        }
        val params = createWindowParams(feedBounds).apply {
            if (blur && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags = flags or WindowManager.LayoutParams.FLAG_BLUR_BEHIND
                blurBehindRadius = SCRIM_BLUR_RADIUS_PX
            }
        }

        try {
            windowManager.addView(view, params)
            scrim = view
            scrimParams = params
            if (instant) {
                whenOnScreen(view, opaque)
            } else {
                // The first scroll event is already ~100ms late; a short fade reads as
                // intentional rather than as a late snap.
                view.animate().alpha(1f).setDuration(SCRIM_FADE_IN_MS).withEndAction(opaque).start()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to show scrim", e)
            opaque()
        }
    }

    private fun hideScrim() {
        scrimToken++ // render() has placed the covers; a pending onOpaque must not remove them
        val view = scrim ?: return
        view.animate().cancel()
        view.animate().alpha(0f).setDuration(SCRIM_FADE_OUT_MS).withEndAction {
            // A new scroll may have reclaimed the scrim mid-fade
            if (scrim === view && view.alpha == 0f) {
                try { windowManager.removeView(view) } catch (_: Exception) { }
                scrim = null
                scrimParams = null
            }
        }.start()
    }

    // --- Post covers ---

    /** The cover's view once added, or null if the window couldn't be added. */
    private fun addCover(cover: Cover): View? {
        return try {
            val view = when (cover) {
                is Cover.Scored -> createCoverView(cover.score.score.toString(), cover.score.reason)
                is Cover.Pending -> createCoverView(PENDING_LABEL, "")
                is Cover.Unidentified -> createCoverView(UNIDENTIFIED_LABEL, "")
                is Cover.Ad -> createCoverView(AD_LABEL, "")
                // Touches still reach the stream underneath, so say how to leave
                is Cover.Live -> createCoverView(LIVE_LABEL, "LIVE is hidden. Swipe on or go back.")
                is Cover.Ai -> createCoverView(AI_LABEL, "Labeled AI-generated")
                is Cover.Shorts -> createCoverView(SHORTS_LABEL, if (cover.player) "Shorts are hidden. Go back or tap Home." else "")
            }
            val params = createWindowParams(cover.bounds)
            windowManager.addView(view, params)
            covers[cover.contentHash] = CoverWindow(cover, view, params)
            view
        } catch (e: Exception) {
            Log.w(TAG, "Failed to add cover", e)
            null
        }
    }

    private fun removeCover(contentHash: String) {
        val window = covers.remove(contentHash) ?: return
        removeWindow(window.view)
    }

    private fun removeAllCovers() {
        covers.keys.toList().forEach { removeCover(it) }
        retiring.forEach(::removeWindow)
        retiring.clear()
    }

    /**
     * Opaque black cover with a gray badge and the scoring reason. Every badge is the same
     * gray, as in the extension: a red badge on the posts we most want skipped was the most
     * eye-catching thing on screen.
     */
    private fun createCoverView(label: String, reason: String): View {
        val container = FrameLayout(context)
        container.setBackgroundColor(Color.BLACK)

        val badge = TextView(context).apply {
            text = label
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER

            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(BADGE_COLOR)
                cornerRadius = dpToPx(16f)
            }

            val pad = dpToPx(12f).toInt()
            setPadding(pad, pad / 2, pad, pad / 2)
        }

        val badgeParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
            gravity = Gravity.CENTER
        }
        container.addView(badge, badgeParams)

        if (reason.isNotBlank()) {
            val reasonView = TextView(context).apply {
                text = reason
                textSize = 11f
                setTextColor(Color.parseColor("#CCCCCC"))
                gravity = Gravity.CENTER
                maxLines = 2
                val pad = dpToPx(16f).toInt()
                setPadding(pad, 0, pad, 0)
            }
            val reasonParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.CENTER
                topMargin = dpToPx(36f).toInt()
            }
            container.addView(reasonView, reasonParams)
        }

        return container
    }

    /**
     * WindowManager.LayoutParams for an overlay that:
     * - Covers [bounds], or the full screen when null (TYPE_ACCESSIBILITY_OVERLAY)
     * - Passes all touches through to the app below (FLAG_NOT_TOUCHABLE)
     * - Cannot receive focus (FLAG_NOT_FOCUSABLE)
     */
    private fun createWindowParams(bounds: ScreenBounds?): WindowManager.LayoutParams {
        val width = bounds?.let { (it.right - it.left).coerceAtLeast(1) }
            ?: WindowManager.LayoutParams.MATCH_PARENT
        val height = bounds?.let { (it.bottom - it.top).coerceAtLeast(1) }
            ?: WindowManager.LayoutParams.MATCH_PARENT
        return WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = bounds?.left ?: 0
            y = bounds?.top ?: 0
        }
    }

    private fun dpToPx(dp: Float): Float =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            dp,
            context.resources.displayMetrics
        )

    companion object {
        private const val TAG = "Tolerance.Overlay"

        private const val SCRIM_FADE_IN_MS = 90L
        private const val SCRIM_FADE_OUT_MS = 120L
        // After a replacement cover draws, how long the old one stays under it: ~3 frames
        private const val REPLACE_OVERLAP_MS = 50L
        private const val REPLACE_MAX_WAIT_MS = 300L
        private const val SCRIM_BLUR_RADIUS_PX = 80
        private val SCRIM_TINT_OVER_BLUR = Color.argb(70, 0, 0, 0)
        private val SCRIM_OPAQUE = Color.rgb(24, 24, 27)

        private const val PENDING_LABEL = "…"
        private const val AD_LABEL = "Ad"
        private const val LIVE_LABEL = "LIVE"
        private const val AI_LABEL = "AI"
        private const val SHORTS_LABEL = "Shorts"
        // Arrow down to a bar: the identifying header is above, scrolled out of view
        private const val UNIDENTIFIED_LABEL = "⤓"
        // The extension's rgb(60, 60, 60) badge
        private val BADGE_COLOR = Color.rgb(60, 60, 60)
        // Same gray, a little see-through so it sits lightly on the video
        private val SCORE_TAG_COLOR = Color.argb(217, 60, 60, 60)
        // Fraction of the way down the video. TikTok's top tabs end ~11% down; the middle
        // spot is clear of them and of the caption
        private const val SCORE_TAG_TOP = 0.13f
        private const val SCORE_TAG_MIDDLE = 0.4f
    }
}
