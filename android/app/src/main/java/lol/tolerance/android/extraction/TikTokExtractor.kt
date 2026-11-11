package lol.tolerance.android.extraction

import android.view.accessibility.AccessibilityNodeInfo
import lol.tolerance.android.scoring.ScoringSpec

/**
 * Extracts the video on screen from TikTok's home feed (com.zhiliaoapp.musically 47.5-47.6).
 *
 * Classic Android views. Named IDs (below) have held across releases; obfuscated ones
 * haven't, so the action buttons are matched by description instead. Only the visible page
 * is in the tree — the next video can't be read (or scored) ahead of time:
 *
 *   ViewPager 'viewpager'                 ← vertical feed, one page per video
 *     FrameLayout 'view_rootview'         ← page
 *       View 'long_press_layout' D:Video  ← the video surface, bounds used for the cover
 *       … 'title'  T:<creator name>
 *       … 'desc'   T:<caption>…more
 *       … Button D:"Follow <creator>"     ← only when not followed
 *       … Button D:"Like video. 1.3M likes" / "Share video. N shares"
 *       … Button D:"Read or add comments. 33.7K comments"
 *       … Button D:"Sound: <sound>"
 *       … 'tv_label' T:"Photo"; TextView T:"Contains AI-generated media" / "Promotional content"
 *
 * The top tabs (Community / Following / For You) are views with the tab name as content
 * description; the current one is selected.
 *
 * What the recommender pushes is the regretted part; videos from creators the user follows,
 * and the Following tab, are what they chose ([PostData.isChosen]).
 *
 * LIVE comes as a whole-screen room ([inLiveRoom]) or as a stream previewing in the feed: a
 * page whose surface reads D:"LIVE", with 'tv_live_tips' ("Tap to watch LIVE") and the host
 * in 'tv_live_nickname' instead of 'title'. Either is returned as one [PostData.isLive] post.
 */
class TikTokExtractor : ContentExtractor {

    override val platform = Platform.TIKTOK

    /**
     * In a LIVE room (its own activity, which the service sees in window-state events and
     * sets here). Read on the extraction thread.
     */
    @Volatile var inLiveRoom = false

    override fun extractPosts(rootNode: AccessibilityNodeInfo): List<PostData> {
        if (inLiveRoom) return listOf(livePost("room", ExtractionUtils.getScreenBounds(rootNode)))
        val posts = mutableListOf<PostData>()
        try {
            val scan = Scan().also { it.walk(rootNode, 0) }
            val followingTab = scan.selectedTab == FOLLOWING_TAB
            // Every page of the feed pager, so pages without a video surface (LIVE previews)
            // are seen too; if the pager isn't found, the pages holding a video surface
            val pages = scan.pager?.let { pager -> (0 until pager.childCount).mapNotNull { pager.getChild(it) } }
                ?: scan.surfaces.mapNotNull { it.parent }
            for (page in pages) {
                if (ExtractionUtils.getScreenBounds(page).isEmpty) continue
                try { parsePage(page, followingTab)?.let { posts.add(it) } } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        return posts
    }

    /** Video surfaces, the feed pager and the selected top tab, in one walk. */
    private class Scan {
        val surfaces = mutableListOf<AccessibilityNodeInfo>()
        var pager: AccessibilityNodeInfo? = null
        var selectedTab: String? = null

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH) return
            if (idOf(node) == SURFACE_ID && !ExtractionUtils.getScreenBounds(node).isEmpty) surfaces.add(node)
            // The tab pagers above it share the id but aren't ViewPagers; deepest wins
            if (idOf(node) == PAGER_ID && node.className?.endsWith("ViewPager") == true) pager = node
            if (node.isSelected && selectedTab == null) {
                node.contentDescription?.toString()?.takeIf { it in TABS }?.let { selectedTab = it }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { walk(it, depth + 1) }
            }
        }
    }

    /** A LIVE room or in-feed LIVE preview: nothing in it to score, covered all or nothing. */
    private fun livePost(key: String, bounds: ScreenBounds) = PostData(
        id = "${Platform.TIKTOK.name}:live:$key",
        platform = Platform.TIKTOK,
        author = "",
        text = "",
        score = null,
        numComments = 0,
        subreddit = null,
        screenBounds = bounds,
        isLive = true,
    )

    private fun parsePage(page: AccessibilityNodeInfo, followingTab: Boolean): PostData? {
        var surface: AccessibilityNodeInfo? = null
        var liveBadge = false
        var liveHost: String? = null
        var aiLabeled = false
        var creator: String? = null
        var caption = ""
        var notFollowed = false
        var isAd = false
        var likes: Int? = null
        var comments = 0
        var sound: String? = null
        val labels = mutableListOf<String>()

        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH) return
            val text = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            when (idOf(node)) {
                SURFACE_ID -> if (surface == null) {
                    surface = node
                    // "Video" on a video, "LIVE" on a stream previewing in the feed
                    if (desc == LIVE_SURFACE) liveBadge = true
                }
                "tv_live_tips" -> liveBadge = true // "Tap to watch LIVE"
                "tv_live_nickname" -> if (text.isNotEmpty()) liveHost = text
                "title" -> if (creator == null && text.isNotEmpty()) creator = text
                // Long captions are cut off with "…more"
                "desc" -> caption = text.removeSuffix("…more").trimEnd()
                "tv_label" -> if (text.isNotEmpty()) labels += text
            }
            // The action buttons' ids are reshuffled between releases (47.6 moved Like, comments
            // and sound); their screen-reader descriptions aren't
            when {
                desc.startsWith(FOLLOW_PREFIX) -> notFollowed = true
                desc.startsWith(LIKES_PREFIX) -> likes = metric(desc, "likes")
                desc.startsWith(COMMENTS_PREFIX) -> comments = metric(desc, "comments") ?: 0
                desc.startsWith(SOUND_PREFIX) ->
                    sound = desc.removePrefix(SOUND_PREFIX).trim().takeIf { it.isNotEmpty() }
            }
            if (text in AD_LABELS || desc in AD_LABELS) isAd = true
            // Creator brand deals, disclosed in a small gray tag; the caption saying it doesn't count
            if (idOf(node) != "desc" && PROMO_LABELS.any { text.startsWith(it, ignoreCase = true) }) {
                isAd = true
            }
            // TikTok's own label or the creator's; the caption saying it doesn't count
            if (idOf(node) != "desc" && text.contains(AI_LABEL, ignoreCase = true)) {
                labels += text
                aiLabeled = true
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { visit(it, depth + 1) }
            }
        }
        visit(page, 0)

        // A LIVE stream previewing in the feed: no creator or caption, the host is named apart
        if (liveBadge) return livePost("feed:$liveHost", ExtractionUtils.getScreenBounds(surface ?: page))
        val video = surface ?: return null
        val author = creator ?: return null
        val details = buildList {
            sound?.let { add("Sound: $it") }
            if (labels.isNotEmpty()) add("Labels: ${labels.distinct().joinToString("; ")}")
        }.joinToString(". ").ifEmpty { null }

        return PostData(
            id = "${Platform.TIKTOK.name}:${(author + caption + details).hashCode().toUInt().toString(16)}",
            platform = Platform.TIKTOK,
            author = author,
            text = if (isAd) ScoringSpec.SPONSORED_PREFIX + caption else caption,
            score = likes,
            numComments = comments,
            subreddit = null,
            screenBounds = ExtractionUtils.getScreenBounds(video),
            isAd = isAd,
            // No Follow button: the user follows this creator (or it's their own video)
            isChosen = followingTab || !notFollowed,
            isAiLabeled = aiLabeled,
            media = ScoringSpec.Media.REEL,
            details = details,
            node = video,
        )
    }

    /** "Like video. 1.3M likes" → 1300000 */
    private fun metric(desc: String, unit: String): Int? =
        Regex("([\\d.,]+\\s*[KMB]?)\\s+$unit").find(desc)?.groupValues?.get(1)?.let(ExtractionUtils::parseMetric)

    companion object {
        private const val SURFACE_ID = "long_press_layout"
        private const val PAGER_ID = "viewpager"
        // The video surface's description on a LIVE stream previewing in the feed
        private const val LIVE_SURFACE = "LIVE"
        private const val FOLLOWING_TAB = "Following"
        private val TABS = setOf("Community", FOLLOWING_TAB, "For You", "Explore", "STEM", "LIVE")
        // TikTok's paid in-feed ads
        private val AD_LABELS = setOf("Sponsored", "Ad", "Promoted")
        // Creators' paid promotions, labeled by TikTok's content disclosure setting
        private val PROMO_LABELS = listOf("Promotional content", "Paid partnership")
        private const val FOLLOW_PREFIX = "Follow " // "Follow <creator>", only when not followed
        private const val LIKES_PREFIX = "Like video."
        private const val COMMENTS_PREFIX = "Read or add comments."
        private const val SOUND_PREFIX = "Sound:"
        // "Contains AI-generated media", "Creator labeled as AI-generated", …
        private const val AI_LABEL = "AI-generated"
        private const val MAX_DEPTH = 60

        /** "com.zhiliaoapp.musically:id/desc" → "desc" */
        private fun idOf(node: AccessibilityNodeInfo): String? =
            node.viewIdResourceName?.substringAfter(":id/", "")?.ifEmpty { null }
    }
}

private val ScreenBounds.isEmpty get() = right <= left || bottom <= top
