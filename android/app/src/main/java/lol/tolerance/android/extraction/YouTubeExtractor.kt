package lol.tolerance.android.extraction

import android.view.accessibility.AccessibilityNodeInfo
import lol.tolerance.android.scoring.ScoringSpec

/**
 * Extracts videos from the YouTube app's feeds (21.44).
 *
 * Each feed item is a child of the RecyclerView 'results'. The item, or a view inside it,
 * describes the whole video in one content description:
 *
 *   "What Orwell Personally Believed - 15 minutes, 25 seconds - Go to channel Ryan Chapman -
 *    Ryan Chapman, Verified - 1.8 million views - 5 years ago - play video"
 *   "Sponsored - <ad text> - Visit site - Link opens in new window"
 *
 * A card's child also holds what sits under the video (a comments teaser), so the cover
 * spans the whole list child. The thumbnail isn't readable; the title and length are what
 * get scored (scoring spec v5: length is part of the effort).
 *
 * Shorts come as a shelf in the feed — a header item described "Shorts", then a row item
 * of "<title> - play Short" cards — or as the full-screen player ('reel_watch_fragment_root').
 * Neither shows a channel or views, so they're [PostData.isShorts], hidden or not as a whole.
 */
class YouTubeExtractor : ContentExtractor {

    override val platform = Platform.YOUTUBE

    override fun extractPosts(rootNode: AccessibilityNodeInfo): List<PostData> {
        val posts = mutableListOf<PostData>()
        try {
            val scan = Scan().also { it.walk(rootNode, 0) }
            // The Shorts player fills the screen; nothing else on it is a feed
            scan.shortsPlayer?.let { return listOf(shortsPost(ExtractionUtils.getScreenBounds(it), player = true)) }
            val list = scan.list ?: return posts
            for (i in 0 until list.childCount) {
                val item = list.getChild(i) ?: continue
                try {
                    if (isShortsShelf(item, 0)) posts.add(shortsPost(ExtractionUtils.getScreenBounds(item), player = false))
                    else parseItem(item)?.let { posts.add(it) }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        return posts
    }

    /** All or nothing, like TikTok LIVE: a Short shows no channel or views to score by. */
    private fun shortsPost(bounds: ScreenBounds, player: Boolean): PostData {
        // Distinct text per spot on screen, so a shelf's header and row get a cover each
        val key = if (player) "player" else "shelf:${bounds.top}"
        return PostData(
            id = "${Platform.YOUTUBE.name}:shorts:$key",
            platform = Platform.YOUTUBE,
            author = "",
            text = "shorts:$key",
            score = null,
            numComments = 0,
            subreddit = null,
            screenBounds = bounds,
            isShorts = true,
            isShortsPlayer = player,
        )
    }

    /** A feed item that's part of a Shorts shelf: its "Shorts" header, or a row of Shorts. */
    private fun isShortsShelf(node: AccessibilityNodeInfo, depth: Int): Boolean {
        val desc = node.contentDescription?.toString()
        if (desc == SHORTS_HEADER || desc?.endsWith(PLAY_SHORT) == true) return true
        if (depth >= MAX_ITEM_DEPTH) return false
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (isShortsShelf(child, depth + 1)) return true
        }
        return false
    }

    private fun parseItem(item: AccessibilityNodeInfo): PostData? {
        val desc = findDescription(item, 0) ?: return null
        val video = parseDescription(desc) ?: return null
        return PostData(
            id = "${Platform.YOUTUBE.name}:${(video.title + video.channel).hashCode().toUInt().toString(16)}",
            platform = Platform.YOUTUBE,
            author = video.channel,
            text = if (video.isAd) ScoringSpec.SPONSORED_PREFIX + video.title else video.title,
            score = video.views,
            numComments = 0,
            subreddit = null,
            screenBounds = ExtractionUtils.getScreenBounds(item),
            isAd = video.isAd,
            media = ScoringSpec.Media.VIDEO,
            length = video.length,
            node = item,
        )
    }

    /** The first content description in the item that describes a video or an ad. */
    private fun findDescription(node: AccessibilityNodeInfo, depth: Int): String? {
        val desc = node.contentDescription?.toString()
        if (desc != null && (desc.endsWith(PLAY_VIDEO) || desc.endsWith(PLAY_SHORT) || desc.startsWith(SPONSORED))) return desc
        if (depth >= MAX_ITEM_DEPTH) return null
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findDescription(child, depth + 1)?.let { return it }
        }
        return null
    }

    /**
     * One walk for the feed's list — the tallest 'results' RecyclerView, as each tab keeps
     * its own — and the Shorts player, if it's showing.
     */
    private class Scan {
        var list: AccessibilityNodeInfo? = null
        var shortsPlayer: AccessibilityNodeInfo? = null
        private var listHeight = 0

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH) return
            val id = node.viewIdResourceName
            if (id?.endsWith(LIST_ID) == true) {
                val height = ExtractionUtils.getScreenBounds(node).let { it.bottom - it.top }
                if (height > listHeight) { list = node; listHeight = height }
            }
            if (id?.endsWith(SHORTS_PLAYER_ID) == true && shortsPlayer == null) {
                val bounds = ExtractionUtils.getScreenBounds(node)
                if (bounds.bottom > bounds.top) shortsPlayer = node
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
    }

    data class Video(
        val title: String,
        val channel: String,
        val views: Int?,
        val length: String?, // "15:25", "1:02:03", "Short" or "live stream"
        val isAd: Boolean,
    )

    companion object {
        private const val LIST_ID = ":id/results"
        // The Shorts player, from the Shorts tab or a Short opened from the feed
        private const val SHORTS_PLAYER_ID = ":id/reel_watch_fragment_root"
        private const val SHORTS_HEADER = "Shorts"
        private const val PLAY_VIDEO = "play video"
        private const val PLAY_SHORT = "play Short"
        private const val SPONSORED = "Sponsored"
        private const val CHANNEL_PREFIX = "Go to channel "
        private const val MAX_DEPTH = 30
        private const val MAX_ITEM_DEPTH = 4

        private val DURATION = Regex("^(?:(\\d+) hours?,? ?)?(?:(\\d+) minutes?,? ?)?(?:(\\d+) seconds?)?$")
        private val VIEWS = Regex("^([\\d.,]+)\\s*(thousand|million|billion|K|M|B)?\\s*views?$", RegexOption.IGNORE_CASE)
        private val WATCHING = Regex("watching", RegexOption.IGNORE_CASE)

        /**
         * Parse an item's description. Parts are separated by " - ", but a title can contain
         * " - " too, so the title is everything before the first part that isn't title: the
         * length, or the channel link. Pure, for unit tests.
         */
        fun parseDescription(desc: String): Video? {
            if (desc.startsWith(SPONSORED)) {
                // "Sponsored - <headline>\n<body>\n<advertiser> - Visit site - …"
                val body = desc.removePrefix(SPONSORED).trimStart(' ', '-')
                val lines = body.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
                val advertiser = lines.lastOrNull()?.substringBefore(" - ")?.trim().orEmpty()
                val text = lines.dropLast(1).joinToString(" ").ifEmpty { body.substringBefore(" - ") }
                return Video(text, advertiser, null, null, isAd = true)
            }
            val parts = desc.split(" - ").map { it.trim() }
            val channelAt = parts.indexOfFirst { it.startsWith(CHANNEL_PREFIX) }
            val durationAt = parts.indexOfFirst { it.isNotEmpty() && DURATION.matches(it) && it.any(Char::isDigit) }
            val titleEnd = listOf(durationAt, channelAt).filter { it > 0 }.minOrNull() ?: return null
            val title = parts.subList(0, titleEnd).joinToString(" - ").trim()
            if (title.isEmpty()) return null

            val channel = parts.getOrNull(channelAt)?.removePrefix(CHANNEL_PREFIX)?.trim().orEmpty()
            val views = parts.firstNotNullOfOrNull { VIEWS.find(it) }?.let(::viewCount)
            val length = when {
                desc.endsWith(PLAY_SHORT) -> "Short"
                parts.any { WATCHING.containsMatchIn(it) } -> "live stream"
                durationAt > 0 -> clock(DURATION.find(parts[durationAt])!!)
                else -> null
            }
            return Video(title, channel, views, length, isAd = false)
        }

        /** "1.8 million views" → 1800000 */
        private fun viewCount(match: MatchResult): Int? {
            val number = match.groupValues[1].replace(",", "").toDoubleOrNull() ?: return null
            val scale = when (match.groupValues[2].lowercase()) {
                "thousand", "k" -> 1_000.0
                "million", "m" -> 1_000_000.0
                "billion", "b" -> 1_000_000_000.0
                else -> 1.0
            }
            return (number * scale).coerceAtMost(Int.MAX_VALUE.toDouble()).toInt()
        }

        /** "1 hour, 2 minutes, 3 seconds" → "1:02:03"; "15 minutes, 25 seconds" → "15:25" */
        private fun clock(match: MatchResult): String {
            val (h, m, s) = match.destructured.toList().map { it.toIntOrNull() ?: 0 }
            return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
        }
    }
}
