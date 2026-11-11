package lol.tolerance.android.service

import android.accessibilityservice.AccessibilityService
import android.content.SharedPreferences
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.*
import kotlin.math.abs
import lol.tolerance.android.BuildConfig
import lol.tolerance.android.api.CreditMonitor
import lol.tolerance.android.api.KeyStore
import lol.tolerance.android.api.UpdateChecker
import lol.tolerance.android.api.ProvisioningClient
import lol.tolerance.android.boredom.ProgressiveBoredomTracker
import lol.tolerance.android.boredom.Strictness
import lol.tolerance.android.extraction.*
import lol.tolerance.android.scoring.ScoringService
import lol.tolerance.android.scoring.TopicStore

/**
 * Three jobs, kept apart so the main thread only ever does cheap work:
 *
 * - **Scroll state** (main): TYPE_VIEW_SCROLLED starts a scroll and shows the scrim;
 *   SETTLE_MS without another one ends it. X sends these every ~105ms through a fling,
 *   but with no usable scroll delta, so we don't try to track positions.
 * - **Identify** (background): one tree walk per settle / content change, single-flight.
 *   Results are dropped if a scroll started while it ran.
 * - **Score** (IO): async per batch; a finished batch triggers a fresh identify pass.
 */
class ToleranceAccessibilityService : AccessibilityService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var keyStore: KeyStore
    private lateinit var scoringService: ScoringService
    private lateinit var overlayManager: OverlayManager
    private lateinit var tracker: ContentTracker
    private lateinit var boredomTracker: ProgressiveBoredomTracker
    private lateinit var topicStore: TopicStore
    private lateinit var mediaMute: MediaMute
    private lateinit var credits: CreditMonitor
    private lateinit var updateChecker: UpdateChecker
    private lateinit var prefs: SharedPreferences

    private val tikTok = TikTokExtractor()
    private val extractors = mapOf(
        Platform.TWITTER to TwitterExtractor(),
        Platform.REDDIT to RedditExtractor(),
        Platform.YOUTUBE to YouTubeExtractor(),
        Platform.INSTAGRAM to InstagramExtractor(),
        Platform.TIKTOK to tikTok,
    )

    // Per-post scoring state, keyed by contentHash. Main thread only.
    private val scoreCache = boundedMap<ScoringService.PostScore>()
    private val scoringInFlight = HashSet<String>()
    private val unscorable = boundedMap<Unit>()   // attempted, no score came back — don't retry
    private val pendingSince = boundedMap<Long>() // first seen unscored (uptime), for the timeout
    // Topic set the scores above were made with; a change makes them stale
    private var scoredTopicsKey = ""

    private var lastPlatform: Platform? = null

    // On a post's own page (see ContentExtractor.isReadingScreen), as of the last identify
    // pass. Main thread only. Can lag a just-opened page by CONTENT_THROTTLE_MS.
    private var onReadingScreen = false

    // Scroll state. Main thread only.
    private var scrolling = false
    private var scrollGeneration = 0
    private val settleRunnable = Runnable { onScrollSettled() }

    // Identify pass state. Main thread only.
    private var identifyJob: Job? = null
    private var identifyAgain = false
    private var identifyScheduled = false
    private val scheduledIdentify = Runnable {
        identifyScheduled = false
        if (!scrolling) requestIdentify()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "Service connected")

        keyStore = KeyStore.getInstance(this)
        val provisioningClient = ProvisioningClient(keyStore)
        topicStore = TopicStore(this)
        scoredTopicsKey = topicStore.key()
        credits = CreditMonitor(this)
        updateChecker = UpdateChecker(this)
        scoringService = ScoringService(keyStore, provisioningClient, topicStore, credits)
        overlayManager = OverlayManager(this)
        tracker = ContentTracker(resources.displayMetrics.heightPixels, ::onContentMoved)
        boredomTracker = ProgressiveBoredomTracker(this)
        mediaMute = MediaMute(this)
        prefs = getSharedPreferences("tolerance_prefs", MODE_PRIVATE)

        scope.launch {
            if (!keyStore.isConfigured()) {
                provisioningClient.provisionFreeKey()
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val packageName = event.packageName?.toString() ?: return
        val platform = Platform.fromPackage(packageName)

        // Non-monitored app — only clear on a genuine app switch (new Activity),
        // ignore system UI, keyboard, notification, and other background events.
        if (platform == null || !isPlatformEnabled(platform)) {
            if (lastPlatform != null &&
                event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
                packageName != "com.android.systemui" &&
                packageName != "lol.tolerance.android"
            ) {
                Log.i(TAG, "App switch detected: $packageName, clearing overlays")
                reset()
                lastPlatform = null
            }
            return
        }

        // Platform changed — clear old overlays
        if (lastPlatform != null && lastPlatform != platform) {
            reset()
        }
        // Opening a feed is when an update notice is most useful; checks GitHub at most daily
        if (lastPlatform == null && BuildConfig.GITHUB_UPDATES) {
            scope.launch { updateChecker.checkAndNotify() }
        }

        boredomTracker.recordActivity()
        lastPlatform = platform
        // A LIVE room is its own activity. Dialogs and panels send state changes too, with
        // their view class, so only activities count.
        if (platform == Platform.TIKTOK && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.className?.toString()?.takeIf { it.endsWith("Activity") }?.let {
                val live = it.endsWith(TIKTOK_LIVE_ACTIVITY)
                if (live != tikTok.inLiveRoom) Log.d(TAG, "TikTok LIVE room ${if (live) "entered" else "left"}: $it")
                tikTok.inLiveRoom = live
            }
        }
        overlayManager.setDebugRuler(prefs.getBoolean("debug_scroll_ruler", false) && hasRuler(platform))

        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> {
                onScroll(event)
                tracker.requestRead()
            }

            // Layout can change without a scroll (feed loads, post expands, navigation).
            // Throttle rather than debounce: autoplaying video fires these continuously,
            // and a cancel-and-restart debounce would never run.
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                // Content can move with no scroll event (X's header sliding in)
                tracker.requestRead()
                if (!scrolling && !identifyScheduled) {
                    identifyScheduled = true
                    handler.postDelayed(scheduledIdentify, CONTENT_THROTTLE_MS)
                }
            }
        }
    }

    // --- Scroll state ---

    private fun onScroll(event: AccessibilityEvent) {
        // Small lists aren't the feed: a TikTok LIVE's comments scroll nonstop, and a scrim
        // over them would flicker. Sources we can't place (those comments, too) are ignored;
        // ContentTracker still catches the feed moving.
        val bounds = sourceBounds(event) ?: return
        if (bounds.bottom - bounds.top < resources.displayMetrics.heightPixels * MIN_FEED_HEIGHT_FRACTION) return
        if (!scrolling) {
            // Source details so unexpected scrims (X scrolling on its own) can be traced
            startScroll(bounds, "source=${event.className} bounds=$bounds scrollY=${event.scrollY}")
        }
        overlayManager.onScrollProgress(event.scrollY, event.eventTime)
        rearmSettle()
    }

    /**
     * Measured movement from [ContentTracker]. Starts a scroll on its own when content moves
     * without scroll events (X's header sliding in), and holds off settling while it moves.
     */
    private fun onContentMoved(deltaPx: Int, uptimeMs: Long) {
        if (lastPlatform == null) return
        if (deltaPx != 0) {
            if (!scrolling && abs(deltaPx) >= MIN_MOVE_TO_START_PX) {
                startScroll(null, "content moved ${deltaPx}px")
            }
            if (scrolling) rearmSettle()
        }
        overlayManager.onContentMoved(deltaPx, uptimeMs)
    }

    private fun startScroll(bounds: ScreenBounds?, cause: String) {
        Log.d(TAG, "Scroll start (blur ${if (isBlurActive()) "on" else "off"}) $cause")
        scrolling = true
        scrollGeneration++
        overlayManager.beginScroll(
            bounds,
            showScrim = isBlurActive() && !onReadingScreen,
            showRuler = lastPlatform?.let(::hasRuler) ?: true,
            // The next video slides in whole; every frame of fade-in shows it
            instant = lastPlatform == Platform.TIKTOK,
        )
    }

    // TikTok pages a whole video per swipe; there's no distance to feel
    private fun hasRuler(platform: Platform) = platform != Platform.TIKTOK

    private fun rearmSettle() {
        handler.removeCallbacks(settleRunnable)
        handler.postDelayed(settleRunnable, SETTLE_MS)
    }

    private fun onScrollSettled() {
        scrolling = false
        requestIdentify()
    }

    /** Bounds of the scrolling container, so the scrim leaves the app's own bars usable. */
    private fun sourceBounds(event: AccessibilityEvent): ScreenBounds? {
        val source = event.source ?: return null
        val rect = Rect()
        source.getBoundsInScreen(rect)
        return if (rect.isEmpty) null else ScreenBounds(rect.left, rect.top, rect.right, rect.bottom)
    }

    // --- Identify ---

    private fun requestIdentify() {
        if (identifyJob?.isActive == true) {
            identifyAgain = true
            return
        }
        val extractor = lastPlatform?.let { extractors[it] }
        if (extractor == null) {
            overlayManager.render(emptyList()) // never leave a scrim up
            return
        }
        val generation = scrollGeneration

        identifyJob = scope.launch {
            try {
                val t0 = SystemClock.uptimeMillis()
                val (posts, reading) = withContext(Dispatchers.Default) { extractVisiblePosts(extractor) }
                Log.d(TAG, "Identify: ${posts.size} posts in ${SystemClock.uptimeMillis() - t0}ms" +
                    if (reading) " (reading screen)" else "")
                onReadingScreen = reading
                tracker.setCandidates(posts.mapNotNull { it.node })

                // Scrolled while we were walking the tree — bounds are stale
                if (generation != scrollGeneration || scrolling) return@launch

                render(posts)
                if (!reading) scoreMissing(posts)
            } catch (e: Exception) {
                Log.e(TAG, "Identify failed", e)
            } finally {
                if (identifyAgain) {
                    identifyAgain = false
                    // Post so this job is no longer active when requestIdentify checks
                    handler.post { if (!scrolling) requestIdentify() }
                }
            }
        }
    }

    /** Visible posts, and whether this is a reading screen. */
    private fun extractVisiblePosts(extractor: ContentExtractor): Pair<List<PostData>, Boolean> {
        val rootNode = rootInActiveWindow ?: return emptyList<PostData>() to false
        return try {
            extractor.extractPosts(rootNode) to extractor.isReadingScreen(rootNode)
        } finally {
            rootNode.recycle()
        }
    }

    private fun render(posts: List<PostData>) {
        // A post the user opened is theirs to read — only ads get covered there
        val blurActive = isBlurActive() && !onReadingScreen
        val untilScored = coversUnscored()
        val penalizeAds = isAdPenaltyOn()
        val threshold = boredomTracker.getCurrentBlurThreshold()
        val now = SystemClock.uptimeMillis()

        val covers = posts.mapNotNull { post ->
            val bounds = post.screenBounds ?: return@mapNotNull null
            // Can't be scored until its header scrolls back into view; cover meanwhile.
            // No timeout — the cover lifts as soon as it's identified.
            if (post.isPartial) return@mapNotNull if (blurActive && untilScored) OverlayManager.Cover.Unidentified(post.id, bounds) else null

            val hash = post.contentHash
            // Ads score 10 (scoring spec v8), so they're covered in every phase — and on
            // reading screens, where nothing else is
            if (post.handledAsAd) return@mapNotNull if (penalizeAds) OverlayManager.Cover.Ad(hash, bounds) else null
            // All or nothing, in every phase: a stream has nothing to score
            if (post.isLive) return@mapNotNull if (isLiveHidden()) OverlayManager.Cover.Live(hash, bounds) else null
            if (post.isShorts) {
                return@mapNotNull if (isShortsHidden()) OverlayManager.Cover.Shorts(hash, bounds, post.isShortsPlayer) else null
            }
            // Like ads: the user's call, in every phase and from followed creators too
            if (post.isAiLabeled && isAiHidden()) return@mapNotNull OverlayManager.Cover.Ai(hash, bounds)
            if (!blurActive || post.isChosen) return@mapNotNull null

            val score = scoreCache[hash]
            when {
                score != null ->
                    if (Strictness.isCovered(score.score, threshold)) OverlayManager.Cover.Scored(hash, bounds, score) else null
                !untilScored || hash in unscorable -> null
                isPendingExpired(hash, now) -> null
                else -> OverlayManager.Cover.Pending(hash, bounds)
            }
        }
        Log.d(TAG, "Render: ${covers.count { it is OverlayManager.Cover.Scored }} scored, " +
            "${covers.count { it is OverlayManager.Cover.Pending }} pending, " +
            "${covers.count { it is OverlayManager.Cover.Unidentified }} unidentified, " +
            "${covers.count { it is OverlayManager.Cover.Ad }} ads, " +
            "${covers.count { it is OverlayManager.Cover.Live }} live (threshold $threshold)")
        overlayManager.render(covers)
        // Covered full-screen video still plays with sound: any covered TikTok, or the
        // Shorts player (feed thumbnails autoplay muted)
        mediaMute.set(
            (lastPlatform == Platform.TIKTOK && covers.isNotEmpty()) ||
                covers.any { it is OverlayManager.Cover.Shorts && it.player }
        )
        if (lastPlatform == Platform.TIKTOK) showVideoScore(posts)
    }

    /** Score tag for the video filling the screen: its score, "…" while scoring, "?" if it failed. */
    private fun showVideoScore(posts: List<PostData>) {
        val position = prefs.getString(PREF_SCORE_TAG, SCORE_TAG_MIDDLE)
        val video = posts.maxByOrNull { post -> post.screenBounds?.let { it.bottom - it.top } ?: 0 }
        val text = when {
            video == null || position == SCORE_TAG_OFF -> null
            video.handledAsAd -> "Ad"
            video.isLive -> null // covered, or deliberately left alone
            else -> scoreCache[video.contentHash]?.score?.toString()
                ?: if (video.contentHash in unscorable) "?" else "…"
        }
        overlayManager.showScoreTag(text, video?.screenBounds, atTop = position == SCORE_TAG_TOP)
    }

    private fun isPendingExpired(hash: String, now: Long): Boolean {
        val since = pendingSince[hash]
        if (since == null) {
            pendingSince[hash] = now
            // Re-render when this cover would time out, in case scoring hangs
            handler.postDelayed({ if (!scrolling) requestIdentify() }, PENDING_TIMEOUT_MS)
            return false
        }
        return now - since >= PENDING_TIMEOUT_MS
    }

    // --- Score ---

    private fun scoreMissing(posts: List<PostData>) {
        // Topics changed in Settings: scores made against the old set are stale
        val topicsKey = topicStore.key()
        if (topicsKey != scoredTopicsKey) {
            scoredTopicsKey = topicsKey
            scoreCache.clear()
            unscorable.clear()
        }
        // Chosen posts are scored too — never covered, but TikTok's score tag shows them
        val missing = posts.filter {
            !it.handledAsAd && !it.isPartial && !it.isLive && !it.isShorts &&
                it.contentHash !in scoreCache &&
                it.contentHash !in scoringInFlight &&
                it.contentHash !in unscorable
        }
        if (missing.isEmpty()) return
        // Out of credit and not yet time to check again: leave them unscored, not unscorable
        if (!credits.mayTry()) return

        val hashes = missing.map { it.contentHash }
        scoringInFlight.addAll(hashes)
        Log.i(TAG, "Scoring ${missing.size} new posts from ${missing.first().platform.name}")

        scope.launch {
            var refused = false
            var newlyRefused = false
            try {
                val outcome = withContext(Dispatchers.IO) { scoringService.scorePosts(missing) }
                Log.i(TAG, "Got ${outcome.scores.size} scores back: ${outcome.scores.map { it.score }}" +
                    if (outcome.keyRefused) " (key refused)" else "")
                for (score in outcome.scores) scoreCache[score.contentHash] = score
                refused = outcome.keyRefused
                newlyRefused = outcome.newlyRefused
            } catch (e: Exception) {
                Log.e(TAG, "Error scoring posts", e)
            } finally {
                scoringInFlight.removeAll(hashes.toSet())
                // Refused for lack of credit: retried once there is some. Otherwise a post
                // that got no score isn't asked about again this session.
                if (!refused) {
                    for (hash in hashes) {
                        if (hash !in scoreCache) unscorable[hash] = Unit
                    }
                }
                if (newlyRefused) credits.notifyExhausted(freeTier = keyStore.apiTier != "own-key")
                // Re-render for new scores, or to drop "…" covers now that none are coming
                if (!scrolling && (!refused || newlyRefused || hashes.any { it in scoreCache })) requestIdentify()
            }
        }
    }

    // --- Lifecycle ---

    /**
     * Whether anything unscored may need covering, so scrolls get the scrim. With blur until
     * scored off and the Normal phase's 100 threshold, only rare 10s would be — not worth a
     * scrim on every scroll.
     */
    private fun isBlurActive(): Boolean =
        coversUnscored() || boredomTracker.getCurrentBlurThreshold() < Strictness.MAX_THRESHOLD

    /** Blur until scored, unless no scores are coming: the key is out of credit. */
    private fun coversUnscored(): Boolean = isBlurUntilScoredOn() && !credits.isExhausted()

    private fun reset() {
        handler.removeCallbacks(settleRunnable)
        handler.removeCallbacks(scheduledIdentify)
        identifyScheduled = false
        scrolling = false
        scrollGeneration++ // invalidate any identify pass in flight
        tracker.clear()
        overlayManager.clearAll()
        mediaMute.set(false)
    }

    // Both default on, as in the extension
    private fun isAdPenaltyOn(): Boolean = prefs.getBoolean("penalize_ads", true)
    private fun isBlurUntilScoredOn(): Boolean = prefs.getBoolean("blur_until_scored", true)

    // The Play build has no ad handling: ads are scored like any other post, so a
    // user's own filter rule can still catch them
    private val PostData.handledAsAd: Boolean get() = isAd && BuildConfig.AD_BLOCKING

    // Off until chosen in setup or Settings
    private fun isLiveHidden(): Boolean = prefs.getBoolean(PREF_HIDE_LIVE, false)
    private fun isAiHidden(): Boolean = prefs.getBoolean(PREF_HIDE_AI, false)
    private fun isShortsHidden(): Boolean = prefs.getBoolean(PREF_HIDE_SHORTS, false)

    private fun isPlatformEnabled(platform: Platform): Boolean {
        return prefs.getBoolean("platform_${platform.name.lowercase()}_enabled", true)
    }

    override fun onInterrupt() { reset() }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
        tracker.shutdown()
        handler.removeCallbacksAndMessages(null)
        overlayManager.clearAll()
        mediaMute.set(false)
    }

    companion object {
        private const val TAG = "Tolerance.Service"

        // X sends TYPE_VIEW_SCROLLED every 102–113ms through drags and flings;
        // a gap well past that means the list has stopped.
        private const val SETTLE_MS = 180L
        private const val CONTENT_THROTTLE_MS = 250L
        // Smallest measured movement that counts as the user scrolling (vs. layout jitter)
        private const val MIN_MOVE_TO_START_PX = 6
        // Scrolling containers shorter than this share of the screen don't start a scroll
        private const val MIN_FEED_HEIGHT_FRACTION = 0.4f
        // Matches the extension's DEFAULT_BLUR_UNTIL_SCORED_TIMEOUT
        private const val PENDING_TIMEOUT_MS = 15_000L
        private const val MAX_RECENT = 500
        private const val TIKTOK_LIVE_ACTIVITY = ".LivePlayActivity"

        // Shared with Settings and onboarding (tolerance_prefs)
        const val PREF_HIDE_LIVE = "tiktok_hide_live"
        const val PREF_HIDE_AI = "hide_ai_labeled"
        const val PREF_HIDE_SHORTS = "youtube_hide_shorts"
        const val PREF_SCORE_TAG = "tiktok_score_tag"
        const val SCORE_TAG_TOP = "top"
        const val SCORE_TAG_MIDDLE = "middle"
        const val SCORE_TAG_OFF = "off"

        private fun <V> boundedMap() = object : LinkedHashMap<String, V>(MAX_RECENT, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?) = size > MAX_RECENT
        }
    }
}
