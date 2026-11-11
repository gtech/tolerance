package lol.tolerance.android.extraction

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.robolectric.Shadows.shadowOf
import org.w3c.dom.Element
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Builds an AccessibilityNodeInfo tree from a `uiautomator dump` capture in
 * src/test/resources/fixtures. Captures are sanitized before they're saved
 * (tolerance-android/scripts/sanitize_dump.py): text is replaced, structure is real.
 */
object ScreenFixture {

    /**
     * @param edit sees each node's attributes before it's built; change them to make a
     *   variant of the capture, or return false to drop the node and its subtree
     */
    fun load(path: String, edit: (MutableMap<String, String>) -> Boolean = { true }): AccessibilityNodeInfo {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/$path")
            ?: error("No fixture fixtures/$path")
        val doc = stream.use { DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(it) }
        // <hierarchy> wraps the window's root <node>
        val rootElement = doc.documentElement.childElements().first()
        return build(rootElement, edit) ?: error("Root node dropped")
    }

    private fun build(element: Element, edit: (MutableMap<String, String>) -> Boolean): AccessibilityNodeInfo? {
        val attrs = mutableMapOf<String, String>()
        val map = element.attributes
        for (i in 0 until map.length) attrs[map.item(i).nodeName] = map.item(i).nodeValue
        if (!edit(attrs)) return null

        val node = AccessibilityNodeInfo.obtain()
        attrs["text"]?.takeIf { it.isNotEmpty() }?.let { node.text = it }
        attrs["content-desc"]?.takeIf { it.isNotEmpty() }?.let { node.contentDescription = it }
        attrs["resource-id"]?.takeIf { it.isNotEmpty() }?.let { node.viewIdResourceName = it }
        attrs["class"]?.let { node.className = it }
        node.isScrollable = attrs["scrollable"] == "true"
        node.isSelected = attrs["selected"] == "true"
        node.isClickable = attrs["clickable"] == "true"
        attrs["bounds"]?.let { node.setBoundsInScreen(parseBounds(it)) }

        for (child in element.childElements()) {
            build(child, edit)?.let { shadowOf(node).addChild(it) }
        }
        return node
    }

    /** "[0,83][1080,243]" */
    private fun parseBounds(bounds: String): Rect {
        val n = Regex("-?\\d+").findAll(bounds).map { it.value.toInt() }.toList()
        return Rect(n[0], n[1], n[2], n[3])
    }

    private fun Element.childElements(): List<Element> =
        (0 until childNodes.length).mapNotNull { childNodes.item(it) as? Element }.filter { it.tagName == "node" }
}
