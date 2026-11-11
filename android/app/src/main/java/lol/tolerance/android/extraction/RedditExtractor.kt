package lol.tolerance.android.extraction

import android.view.accessibility.AccessibilityNodeInfo

/**
 * Extracts post data from Reddit's accessibility node tree.
 *
 * Reddit's app shows posts in a scrollable feed. Each post card contains:
 * - Subreddit name (r/...)
 * - Author (u/...)
 * - Post title
 * - Vote count and comment count
 * - Flair/tags
 */
class RedditExtractor : ContentExtractor {

    override val platform = Platform.REDDIT

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

        // Reddit posts have content descriptions or child text containing "r/" and vote info
        val desc = node.contentDescription?.toString() ?: ""
        val text = if (desc.length > 30) desc else ExtractionUtils.collectText(node, 2)

        // Look for subreddit pattern + engagement indicators
        if (SUBREDDIT_PATTERN.containsMatchIn(text) && text.length > 40) {
            val hasVotes = VOTE_PATTERN.containsMatchIn(text)
            val hasComments = COMMENT_PATTERN.containsMatchIn(text)
            if (hasVotes || hasComments) {
                results.add(node)
                return
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
        if (!desc.isNullOrBlank() && desc.length > 30) {
            return parseFromContentDesc(desc, node)
        }
        return parseFromChildren(node)
    }

    private fun parseFromContentDesc(desc: String, node: AccessibilityNodeInfo): PostData? {
        // Extract subreddit
        val subredditMatch = SUBREDDIT_PATTERN.find(desc) ?: return null
        val subreddit = subredditMatch.groupValues[1]

        // Extract author
        val authorMatch = Regex("u/(\\w+)").find(desc)
        val author = authorMatch?.groupValues?.get(1) ?: "unknown"

        // Extract votes
        val votes = VOTE_PATTERN.find(desc)?.let {
            ExtractionUtils.parseMetric(it.groupValues[1])
        }

        // Extract comments
        val comments = COMMENT_PATTERN.find(desc)?.let {
            ExtractionUtils.parseMetric(it.groupValues[1])
        } ?: 0

        // Extract title — the longest substantial text chunk
        // Remove known patterns to isolate the title
        val cleaned = desc
            .replace(SUBREDDIT_PATTERN, "")
            .replace(Regex("u/\\w+"), "")
            .replace(VOTE_PATTERN, "")
            .replace(COMMENT_PATTERN, "")
            .replace(Regex("\\b(upvotes?|downvotes?|points?)\\b", RegexOption.IGNORE_CASE), "")
            .trim()

        // Find the longest remaining text segment
        val titleParts = cleaned.split(Regex("[,.]\\s+")).filter { it.length > 10 }
        val title = titleParts.maxByOrNull { it.length }?.trim() ?: return null
        if (title.length < 5) return null

        return PostData(
            id = "${Platform.REDDIT.name}:${title.hashCode().toUInt().toString(16)}",
            platform = Platform.REDDIT,
            author = author,
            text = title,
            score = votes,
            numComments = comments,
            subreddit = subreddit,
            screenBounds = ExtractionUtils.getScreenBounds(node),
        )
    }

    private fun parseFromChildren(node: AccessibilityNodeInfo): PostData? {
        val allText = ExtractionUtils.collectText(node)

        val subredditMatch = SUBREDDIT_PATTERN.find(allText) ?: return null
        val subreddit = subredditMatch.groupValues[1]

        val title = ExtractionUtils.findLongestText(node)
        if (title.length < 5) return null

        val authorMatch = Regex("u/(\\w+)").find(allText)
        val author = authorMatch?.groupValues?.get(1) ?: "unknown"

        return PostData(
            id = "${Platform.REDDIT.name}:${title.hashCode().toUInt().toString(16)}",
            platform = Platform.REDDIT,
            author = author,
            text = title,
            score = null,
            numComments = 0,
            subreddit = subreddit,
            screenBounds = ExtractionUtils.getScreenBounds(node),
        )
    }

    companion object {
        private val SUBREDDIT_PATTERN = Regex("r/(\\w+)")
        private val VOTE_PATTERN = Regex("([\\d,.]+[KMB]?)\\s*(upvotes?|votes?|points?)", RegexOption.IGNORE_CASE)
        private val COMMENT_PATTERN = Regex("([\\d,.]+[KMB]?)\\s*comments?", RegexOption.IGNORE_CASE)
    }
}
