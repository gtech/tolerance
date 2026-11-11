package lol.tolerance.android.scoring

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Topics: the user describes something in plain words and chooses to hide it or always show it.
 * Ported from the extension's src/shared/topics.ts. Each topic is sent to the model as a
 * narrative theme; a post that matches one has its score pushed to the top (hidden in every
 * phase) or the bottom (never hidden).
 */
data class Topic(
    val id: String,
    val name: String,
    val description: String,
    val hide: Boolean,
) {
    fun asTheme() = ScoringSpec.Theme(name, description)
}

/** What a topic has caught today. Reasons are the model's neutral summaries, not the posts. */
data class TopicHit(val date: String, val count: Int, val recent: List<String>)

class TopicStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("tolerance_topics", Context.MODE_PRIVATE)

    fun topics(): List<Topic> {
        val json = prefs.getString(KEY_TOPICS, null) ?: return emptyList()
        return try {
            val array = JSONArray(json)
            (0 until array.length()).map { i ->
                val o = array.getJSONObject(i)
                Topic(o.getString("id"), o.getString("name"), o.getString("description"), o.getBoolean("hide"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun add(text: String, hide: Boolean): Topic? {
        val description = text.trim()
        if (description.isEmpty()) return null
        val topic = Topic(
            id = "user_${System.currentTimeMillis()}",
            name = if (description.length > NAME_MAX) description.take(NAME_MAX - 1).trim() + "…" else description,
            description = "Posts that clearly fit this description: \"$description\". Similar or neighboring subjects don't count.",
            hide = hide,
        )
        save(topics() + topic)
        return topic
    }

    fun remove(id: String) {
        save(topics().filterNot { it.id == id })
        prefs.edit().putString(KEY_HITS, hitsJson().apply { remove(id) }.toString()).apply()
    }

    /**
     * Identifies the topic set, for cache keys: a score made against other topics is stale.
     * Empty when there are no topics, so scores from before topics existed stay valid.
     */
    fun key(): String {
        val topics = topics()
        if (topics.isEmpty()) return ""
        return topics.joinToString("|") { "${it.id}:${it.hide}" }.hashCode().toUInt().toString(16)
    }

    fun hits(): Map<String, TopicHit> {
        val today = today()
        val json = hitsJson()
        return json.keys().asSequence().associateWith { id ->
            val o = json.getJSONObject(id)
            val recent = o.optJSONArray("recent")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            TopicHit(o.getString("date"), if (o.getString("date") == today) o.getInt("count") else 0, recent)
        }
    }

    fun recordHit(topicId: String, reason: String?) {
        val today = today()
        val json = hitsJson()
        val old = json.optJSONObject(topicId)
        val count = if (old?.optString("date") == today) old.optInt("count") + 1 else 1
        val recent = mutableListOf<String>()
        reason?.takeIf { it.isNotBlank() }?.let { recent += it }
        old?.optJSONArray("recent")?.let { a -> for (i in 0 until a.length()) recent += a.getString(i) }
        json.put(topicId, JSONObject().apply {
            put("date", today)
            put("count", count)
            put("recent", JSONArray(recent.take(RECENT_MAX)))
        })
        prefs.edit().putString(KEY_HITS, json.toString()).apply()
    }

    private fun save(topics: List<Topic>) {
        val array = JSONArray()
        for (t in topics) {
            array.put(JSONObject().apply {
                put("id", t.id); put("name", t.name); put("description", t.description); put("hide", t.hide)
            })
        }
        prefs.edit().putString(KEY_TOPICS, array.toString()).apply()
    }

    private fun hitsJson(): JSONObject =
        try { JSONObject(prefs.getString(KEY_HITS, null) ?: "{}") } catch (_: Exception) { JSONObject() }

    private fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    companion object {
        private const val KEY_TOPICS = "topics"
        private const val KEY_HITS = "topic_hits"
        private const val NAME_MAX = 60
        private const val RECENT_MAX = 5
    }
}
