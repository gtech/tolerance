package lol.tolerance.android.extraction

import android.view.accessibility.AccessibilityNodeInfo

/**
 * Extracts post data from Instagram's accessibility node tree.
 *
 * Instagram shows posts in a feed with:
 * - Author username
 * - Caption text
 * - Like count
 * - Comment count
 * - Media type indicators (reel, carousel, sponsored)
 */
class InstagramExtractor : ContentExtractor {

    override val platform = Platform.INSTAGRAM

    override fun extractPosts(rootNode: AccessibilityNodeInfo): List<PostData> {
        val posts = mutableListOf<PostData>()

        try {
            val postNodes = findPostContainers(rootNode)
            for (node in postNodes) {
                try {
                    extractPost(node)?.let { posts.add(it) }
                } catch (_: Exception) { }
            }
        } catch (_: Exception) { }

        return posts
    }

    private fun findPostContainers(rootNode: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val containers = mutableListOf<AccessibilityNodeInfo>()
        findPostsByPattern(rootNode, containers)
        return containers
    }

    private fun findPostsByPattern(
        node: AccessibilityNodeInfo,
        results: MutableList<AccessibilityNodeInfo>,
        depth: Int = 0,
    ) {
        if (depth > 15) return

        val desc = node.contentDescription?.toString() ?: ""

        // Instagram posts typically have content descriptions with like counts and usernames
        if (desc.length > 20 && LIKE_PATTERN.containsMatchIn(desc)) {
            results.add(node)
            return
        }

        // Check for post structure: username + caption text + engagement
        if (depth < 6) {
            val text = ExtractionUtils.collectText(node, 3)
            if (text.length > 30 && (LIKE_PATTERN.containsMatchIn(text) || COMMENT_TEXT_PATTERN.containsMatchIn(text))) {
                // Make sure it's a post container, not a header or nav element
                if (text.contains("liked") || text.contains("comment") || text.contains("share")) {
                    results.add(node)
                    return
                }
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findPostsByPattern(child, results, depth + 1)
            if (child !in results) child.recycle()
        }
    }

    private fun extractPost(node: AccessibilityNodeInfo): PostData? {
        val desc = node.contentDescription?.toString()
        if (!desc.isNullOrBlank() && desc.length > 20) {
            return parseFromContentDesc(desc, node)
        }
        return parseFromChildren(node)
    }

    private fun parseFromContentDesc(desc: String, node: AccessibilityNodeInfo): PostData? {
        // Instagram content descriptions often look like:
        // "Photo by @username on date. Caption text. N likes, N comments"
        // or "@username's post. Caption... N likes"

        // Extract username
        val usernameMatch = USERNAME_PATTERN.find(desc)
        val author = usernameMatch?.groupValues?.get(1) ?: return null

        // Extract likes
        val likes = LIKE_PATTERN.find(desc)?.let {
            ExtractionUtils.parseMetric(it.groupValues[1])
        }

        // Extract comments
        val comments = COMMENT_COUNT_PATTERN.find(desc)?.let {
            ExtractionUtils.parseMetric(it.groupValues[1])
        } ?: 0

        // Extract caption — remove known patterns to isolate text
        val caption = desc
            .replace(USERNAME_PATTERN, "")
            .replace(LIKE_PATTERN, "")
            .replace(COMMENT_COUNT_PATTERN, "")
            .replace(Regex("Photo by|Video by|Reel by|on \\w+ \\d+, \\d+", RegexOption.IGNORE_CASE), "")
            .replace(Regex("[.·,]+\\s*"), " ")
            .trim()

        if (caption.length < 3 && likes == null) return null

        val text = caption.ifBlank { "(image post by @$author)" }

        return PostData(
            id = "${Platform.INSTAGRAM.name}:${text.hashCode().toUInt().toString(16)}",
            platform = Platform.INSTAGRAM,
            author = "@$author",
            text = text,
            score = likes,
            numComments = comments,
            subreddit = null,
            screenBounds = ExtractionUtils.getScreenBounds(node),
        )
    }

    private fun parseFromChildren(node: AccessibilityNodeInfo): PostData? {
        val allText = ExtractionUtils.collectText(node)
        if (allText.length < 15) return null

        val usernameMatch = USERNAME_PATTERN.find(allText)
        val author = usernameMatch?.groupValues?.get(1) ?: return null

        val caption = ExtractionUtils.findLongestText(node)
        val text = caption.ifBlank { "(image post by @$author)" }

        val likes = LIKE_PATTERN.find(allText)?.let {
            ExtractionUtils.parseMetric(it.groupValues[1])
        }

        return PostData(
            id = "${Platform.INSTAGRAM.name}:${text.hashCode().toUInt().toString(16)}",
            platform = Platform.INSTAGRAM,
            author = "@$author",
            text = text,
            score = likes,
            numComments = 0,
            subreddit = null,
            screenBounds = ExtractionUtils.getScreenBounds(node),
        )
    }

    companion object {
        private val USERNAME_PATTERN = Regex("@(\\w{1,30})")
        private val LIKE_PATTERN = Regex("([\\d,.]+[KMB]?)\\s*likes?", RegexOption.IGNORE_CASE)
        private val COMMENT_COUNT_PATTERN = Regex("([\\d,.]+[KMB]?)\\s*comments?", RegexOption.IGNORE_CASE)
        private val COMMENT_TEXT_PATTERN = Regex("View all \\d+ comments", RegexOption.IGNORE_CASE)
    }
}
