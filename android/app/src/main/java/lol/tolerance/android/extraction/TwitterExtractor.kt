package lol.tolerance.android.extraction

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import lol.tolerance.android.scoring.ScoringSpec

/**
 * Extracts posts from the Jetpack Compose rewrite of the X app (com.x.android.main.MainActivity).
 *
 * Compose exposes testTags as viewIdResourceName (no package prefix). Each post's header row
 * (display name, verified badge, @handle) is tagged "timeline_post"; its parent is the
 * clickable post container holding the body TextViews and the action bar:
 *
 *   View (scrollable)                ← feed list
 *     View (clickable)               ← post container, bounds used for overlays
 *       ImageView  D:<display name>  ← avatar
 *       View 'timeline_post'         ← header: TextView name, View D:Verified, TextView @handle
 *       TextView   T:"Ad"            ← only on promoted posts
 *       TextView   T:<post body>
 *       View (clickable) → View D:"Reply" / "Repost" / "Like" / "Impressions" + TextView count
 *
 * Compose drops off-screen nodes from the tree, so once a post's top scrolls above the screen
 * its header and "Ad" label vanish. Those posts are recognised by body text remembered from
 * when they were fully visible (see [fragmentIndex]).
 *
 * Not thread-safe: the service runs one extraction at a time.
 */
class TwitterExtractor : ContentExtractor {

    override val platform = Platform.TWITTER

    // Body text fragment → the post it came from. null marks a fragment seen in more than
    // one post (e.g. "from youtube.com"), too ambiguous to identify a post by.
    private val fragmentIndex = object : LinkedHashMap<String, PostData?>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PostData?>?) =
            size > MAX_FRAGMENTS
    }

    override fun extractPosts(rootNode: AccessibilityNodeInfo): List<PostData> {
        val posts = mutableListOf<PostData>()
        try {
            val headed = findPostContainers(rootNode)
            for (container in headed) {
                try { parsePost(container)?.let { posts.add(it) } } catch (_: Exception) {}
            }

            // Feed items whose header is off-screen
            val list = headed.firstOrNull()?.parent ?: findFeedList(rootNode)
            if (list != null) {
                for (i in 0 until list.childCount) {
                    val item = list.getChild(i) ?: continue
                    if (item in headed) continue
                    try { recognise(item)?.let { posts.add(it) } } catch (_: Exception) {}
                }
            }
        } catch (_: Exception) {}
        return posts
    }

    /**
     * A post's own page (opened by tapping it) is tagged "PostDetail" ~10 levels down, directly
     * above its scrollable list — so search the layout scaffold and never descend into lists.
     */
    override fun isReadingScreen(rootNode: AccessibilityNodeInfo): Boolean =
        hasTagAboveLists(rootNode, POST_DETAIL_TAG)

    private fun hasTagAboveLists(node: AccessibilityNodeInfo, tag: String, depth: Int = 0): Boolean {
        if (node.viewIdResourceName == tag) return true
        if (node.isScrollable || depth > 20) return false
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (hasTagAboveLists(child, tag, depth + 1)) return true
        }
        return false
    }

    /**
     * Parent of each "timeline_post" header. Quoted posts may carry their own header inside
     * the outer post, so containers nested within another container are dropped.
     *
     * Manual DFS: findAccessibilityNodeInfosByViewId doesn't match Compose testTags.
     */
    private fun findPostContainers(rootNode: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val headers = ExtractionUtils.findNodesById(rootNode, POST_HEADER_TAG)
        val containers = headers.mapNotNull { header ->
            header.parent?.let { it to boundsOf(it) }
        }
        return containers
            .filter { (_, rect) ->
                containers.none { (_, other) -> other != rect && other.contains(rect) }
            }
            .map { it.first }
    }

    private fun parsePost(container: AccessibilityNodeInfo): PostData? {
        var author: String? = null
        var isAd = false
        val bodyParts = mutableListOf<String>()

        for (i in 0 until container.childCount) {
            val child = container.getChild(i) ?: continue
            when {
                child.viewIdResourceName == POST_HEADER_TAG -> author = findAuthor(child)
                child.className == TEXT_VIEW -> {
                    val text = child.text?.toString()?.trim().orEmpty()
                    if (text == AD_LABEL) isAd = true
                    else if (text.isNotEmpty()) bodyParts.add(text)
                }
            }
        }

        val text = bodyParts.joinToString(" ")
        if (author == null) return null
        // Image-only ads can have almost no text; regular posts need enough to score
        if (!isAd && text.length < 5) return null

        val post = PostData(
            id = "${Platform.TWITTER.name}:${text.hashCode().toUInt().toString(16)}",
            platform = Platform.TWITTER,
            author = author,
            // The "Ad" label isn't body text; carry it so the model sees what the user sees
            text = if (isAd) ScoringSpec.SPONSORED_PREFIX + text else text,
            score = findMetric(container, "Like"),
            numComments = findMetric(container, "Reply") ?: 0,
            subreddit = null,
            screenBounds = ExtractionUtils.getScreenBounds(container),
            isAd = isAd,
            node = container,
        )
        indexFragments(bodyParts, post)
        return post
    }

    private fun indexFragments(fragments: List<String>, post: PostData) {
        for (fragment in fragments) {
            if (fragment.length < MIN_FRAGMENT_LENGTH) continue
            if (fragment !in fragmentIndex) {
                fragmentIndex[fragment] = post.copy(node = null)
            } else {
                val known = fragmentIndex[fragment]
                if (known != null && known.contentHash != post.contentHash) fragmentIndex[fragment] = null
            }
        }
    }

    /**
     * A feed item with no visible header: either a post we've seen whole (matched by its
     * body text), an unrecognised post (has an action bar — returned as partial), or not
     * a post at all ("Discover more" headings, carousels, and on a post's detail page the
     * main post's pieces — each action button there is its own list item).
     */
    private fun recognise(item: AccessibilityNodeInfo): PostData? {
        val bounds = ExtractionUtils.getScreenBounds(item)
        for (i in 0 until item.childCount) {
            val child = item.getChild(i) ?: continue
            if (child.className != TEXT_VIEW) continue
            val text = child.text?.toString()?.trim() ?: continue
            fragmentIndex[text]?.let { return it.copy(screenBounds = bounds, node = item) }
        }

        if (ACTION_LABELS.count { findByContentDesc(item, it) != null } < MIN_ACTION_LABELS) return null
        return PostData(
            id = "${Platform.TWITTER.name}:partial:${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}",
            platform = Platform.TWITTER,
            author = "",
            text = "",
            score = null,
            numComments = 0,
            subreddit = null,
            screenBounds = bounds,
            isPartial = true,
            node = item,
        )
    }

    /**
     * Fallback when no header is on screen. X nests the feed list inside a full-height
     * scrollable wrapper, and carousels inside the feed are scrollable too — so take the
     * tallest scrollable, preferring the deepest on ties.
     */
    private fun findFeedList(rootNode: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestHeight = 0
        var bestDepth = -1
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > 25) return
            if (node.isScrollable && node.childCount > 0) {
                val height = boundsOf(node).height()
                if (height > bestHeight || (height == bestHeight && depth > bestDepth)) {
                    best = node; bestHeight = height; bestDepth = depth
                }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { walk(it, depth + 1) }
            }
        }
        walk(rootNode, 0)
        return best
    }

    /**
     * The @handle, or the display name when a long name pushes the handle out of the
     * header — Compose omits clipped text from the tree.
     */
    private fun findAuthor(header: AccessibilityNodeInfo): String? {
        var displayName: String? = null
        for (i in 0 until header.childCount) {
            val text = header.getChild(i)?.text?.toString() ?: continue
            if (text.startsWith("@")) return text
            if (displayName == null) displayName = text
        }
        return displayName
    }

    /**
     * Action bar counts sit either inside the labelled icon View or beside it,
     * so fall back to the icon's parent when the icon itself has no text.
     */
    private fun findMetric(container: AccessibilityNodeInfo, label: String): Int? {
        val icon = findByContentDesc(container, label) ?: return null
        val count = ExtractionUtils.collectText(icon, 2).ifBlank {
            icon.parent?.let { ExtractionUtils.collectText(it, 3) }.orEmpty()
        }
        return ExtractionUtils.parseMetric(count)
    }

    private fun findByContentDesc(
        node: AccessibilityNodeInfo,
        desc: String,
        maxDepth: Int = 4,
    ): AccessibilityNodeInfo? {
        if (node.contentDescription?.toString() == desc) return node
        if (maxDepth <= 0) return null
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findByContentDesc(child, desc, maxDepth - 1)?.let { return it }
        }
        return null
    }

    private fun boundsOf(node: AccessibilityNodeInfo): Rect =
        Rect().also { node.getBoundsInScreen(it) }

    companion object {
        private const val POST_HEADER_TAG = "timeline_post"
        private const val POST_DETAIL_TAG = "PostDetail"
        private const val TEXT_VIEW = "android.widget.TextView"
        private const val AD_LABEL = "Ad"
        private val ACTION_LABELS = listOf("Reply", "Repost", "Like", "Impressions", "Bookmark", "Share")
        // A whole action bar, not a lone button
        private const val MIN_ACTION_LABELS = 3
        private const val MIN_FRAGMENT_LENGTH = 5
        private const val MAX_FRAGMENTS = 1000
    }
}
