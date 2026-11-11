package lol.tolerance.android.extraction

import android.view.accessibility.AccessibilityNodeInfo

/**
 * Interface for platform-specific content extractors.
 * Each implementation traverses the accessibility node tree of a specific app
 * and extracts post data.
 */
interface ContentExtractor {
    val platform: Platform

    /**
     * Extract visible posts from the current accessibility node tree.
     * Returns a list of extracted posts. Failures are silent — return empty list.
     */
    fun extractPosts(rootNode: AccessibilityNodeInfo): List<PostData>

    /**
     * True on screens where the user chose to read one thing (e.g. a post's page) —
     * no blur-while-scrolling and no scoring there, only ad blocking.
     */
    fun isReadingScreen(rootNode: AccessibilityNodeInfo): Boolean = false
}

/**
 * Utility functions shared across extractors.
 */
object ExtractionUtils {

    /**
     * Recursively collect all text from a node subtree.
     */
    fun collectText(node: AccessibilityNodeInfo, maxDepth: Int = 10): String {
        if (maxDepth <= 0) return ""
        val parts = mutableListOf<String>()
        node.text?.toString()?.let { if (it.isNotBlank()) parts.add(it) }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val childText = collectText(child, maxDepth - 1)
            if (childText.isNotBlank()) parts.add(childText)
            child.recycle()
        }
        return parts.joinToString(" ")
    }

    /**
     * Find the longest text node in a subtree — heuristic for the post's main content.
     */
    fun findLongestText(node: AccessibilityNodeInfo, maxDepth: Int = 10): String {
        if (maxDepth <= 0) return ""
        var longest = node.text?.toString() ?: ""
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val childText = findLongestText(child, maxDepth - 1)
            if (childText.length > longest.length) longest = childText
            child.recycle()
        }
        return longest
    }

    /**
     * Find nodes matching a text pattern.
     */
    fun findNodesByText(
        node: AccessibilityNodeInfo,
        pattern: Regex,
        maxDepth: Int = 10,
    ): List<AccessibilityNodeInfo> {
        if (maxDepth <= 0) return emptyList()
        val matches = mutableListOf<AccessibilityNodeInfo>()
        node.text?.toString()?.let { text ->
            if (pattern.containsMatchIn(text)) matches.add(node)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            matches.addAll(findNodesByText(child, pattern, maxDepth - 1))
            // Don't recycle — caller manages lifecycle
        }
        return matches
    }

    /**
     * Find nodes by view ID resource name (partial match).
     */
    fun findNodesById(
        node: AccessibilityNodeInfo,
        idSubstring: String,
        maxDepth: Int = 25,
    ): List<AccessibilityNodeInfo> {
        if (maxDepth <= 0) return emptyList()
        val matches = mutableListOf<AccessibilityNodeInfo>()
        node.viewIdResourceName?.let { id ->
            if (id.contains(idSubstring)) matches.add(node)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            matches.addAll(findNodesById(child, idSubstring, maxDepth - 1))
        }
        return matches
    }

    /**
     * Parse a metric string like "1.2K", "5M", "234" into an integer.
     */
    fun parseMetric(text: String?): Int? {
        if (text.isNullOrBlank()) return null
        val cleaned = text.trim().replace(",", "")
        val match = Regex("([\\d.]+)\\s*([KMBkmb])?").find(cleaned) ?: return null
        val number = match.groupValues[1].toDoubleOrNull() ?: return null
        val multiplier = when (match.groupValues[2].uppercase()) {
            "K" -> 1_000
            "M" -> 1_000_000
            "B" -> 1_000_000_000
            else -> 1
        }
        return (number * multiplier).toInt()
    }

    /**
     * Get the screen bounds of a node.
     */
    fun getScreenBounds(node: AccessibilityNodeInfo): ScreenBounds {
        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)
        return ScreenBounds(rect.left, rect.top, rect.right, rect.bottom)
    }
}
