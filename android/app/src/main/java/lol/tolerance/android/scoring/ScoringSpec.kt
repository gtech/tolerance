package lol.tolerance.android.scoring

import lol.tolerance.android.extraction.Platform
import kotlin.math.roundToInt

/**
 * The scoring spec: what we ask the model to measure. Ported from the extension's
 * src/shared/scoring-spec.ts — keep the rubric, notes and calibration posts in step with it,
 * and bump [VERSION] with the extension's SCORING_SPEC_VERSION.
 *
 * It measures CHEAP PAYOFF: how hard a post grabs attention for how little reading or thinking
 * it asks, and how little it leaves. v8: ads score 10 on every platform. v9: the extension
 * also asks for a description of an attached image; the app sends no images, so its prompts
 * are unchanged and only the version moves. v10: the extension's prompts give posts labeled
 * AI-generated the top score; the app covers labeled AI videos itself (see isAiLabeled), so
 * again only the version moves.
 *
 * Pure Kotlin (no Android types) so it can be unit tested.
 */
object ScoringSpec {

    const val VERSION = 10

    // Put ahead of the text of a post the app itself marks as an ad, so the model can't miss it
    const val SPONSORED_PREFIX = "[Sponsored] "

    enum class Media(val label: String, val note: String) {
        TEXT("text", ""),
        IMAGE(
            "with image",
            "The image is part of the payoff: a striking, cute, funny, sexy or provocative image is a quick hit even with no text. A chart, diagram, map or screenshot of text is content to read, not a hook: judge the effort and value it carries.",
        ),
        GALLERY(
            "image gallery",
            "The image descriptions are part of the payoff: striking, cute, funny or provocative images are quick hits.",
        ),
        VIDEO(
            "video, thumbnail only",
            "You see only a thumbnail or title. Judge what the video promises: a thumbnail or title built to stop the scroll (shocked faces, arrows, cuteness, drama) is a strong hook. A long tutorial or lecture asks for effort.",
        ),
        REEL(
            "short video",
            "Short-form video: quick cuts, \"wait for it\", trending audio, loops and reactions are hooks. A reel that patiently teaches something asks for more effort.",
        ),
    }

    val RUBRIC = """
Measure CHEAP PAYOFF: how hard the post grabs attention for how little reading or thinking it asks, and how little it leaves behind. Feeds are built from quick hits: a laugh, a jolt of outrage, a cute animal, a hot take, a "so true". That is what you are measuring, whether or not the post is honest, kind or clever. The point is to catch what keeps people scrolling.

Rate each from 1 to 10:
- hook: strength of the immediate jolt (humour, outrage, cuteness, lust, envy, fear, awe, novelty, drama about people, "my side is right")
- effort: reading, context or reasoning needed to get anything from it (1 = one glance, 10 = sustained careful reading or thought)
- pull: how much it invites a reaction: like, reply, quote, share, "this is so me", pile-on. Reusable meme formats count.
- value: what remains after the hit. Would a thoughtful person be glad tomorrow that they read it? (useful information, real insight, craft worth slowing down for)

score (1-10), overall cheap payoff. A strong hook for little effort is the core signal; pull raises it; only lasting value lowers it.
- 1-3: asks for real attention and repays it (dense explainers, careful arguments, plain useful information)
- 4-6: a mild hook with real substance, or a weak quick hit
- 7-8: a quick hit: a good joke, a cute animal, a relatable meme, a hot take, a striking image, celebrity or creator drama
- 9-10: built to grab: outrage bait, curiosity gaps ("you won't believe"), engagement farming, tribal pile-ons, shock

Cleverness, humour and wholesomeness do NOT lower the score: a brilliant one-line joke is still a quick hit.
Filler is scroll fuel: a throwaway reply, an in-joke you don't get, "lol", a vague one-liner, a mundane personal update. It costs a glance and leaves nothing, so it keeps the scroll going: 6-7 even with a weak hook. A weak hook never lowers the score; only lasting value does.
When a video's length is given, it is part of the effort: an hour-long lecture, talk or course session asks sustained attention (1-3 even on a hot topic); a two-minute clip asks almost none.
Judge as a regular reader of this feed who follows its topics: in-jokes, jargon and memes from their world land instantly (low effort). Double meanings and innuendo are jokes.

Reference points:
- A thread explaining step by step how database indexes work, with diagrams → 2
- A 2,000-word personal essay on grief → 3
- A news headline stating a policy change plainly → 4
- A reply to a friend: "lmao same, see you there" → 6
- "Repainted the spare room this weekend, going with sage green" → 6
- A photo of a puppy asleep in a teacup → 7
- A relatable "me at 3am" meme → 7
- "BREAKING: what this senator just said should END his career 🧵👇" → 9
""".trim()

    private val AD_NOTE = "\n\nAdvertisements: a post that exists to sell a product or service or to send the reader to a shop or landing page, usually from a brand or business, is an ad, and so is any post labeled ${SPONSORED_PREFIX.trim()}. Give an ad score 10 and value 1, however useful or clever it seems. Say it is an ad in the reason. Ordinary posts that merely mention a product, event or business are not ads."

    /** A post as the model sees it. */
    data class Post(
        val id: String,
        val platform: Platform,
        val text: String,           // Tweet, title or caption
        val source: String,         // @handle, subreddit (no r/), channel or creator
        val likes: Int? = null,     // null = not yet visible
        val comments: Int? = null,
        val bodyText: String? = null,
        val media: Media = Media.TEXT,
        val length: String? = null, // Video length ("1:12:05")
    )

    /** A topic the user asked us to watch for, shown to the model by number. */
    data class Theme(val name: String, val description: String)

    /** Sub-ratings, each 1-10. */
    data class Dims(val hook: Int, val effort: Int, val pull: Int, val value: Int)

    private class Labels(
        val name: String,
        val content: String,
        val source: (String) -> String,
        val likes: String?,
    )

    private fun labels(platform: Platform): Labels = when (platform) {
        Platform.REDDIT -> Labels("Reddit", "Title", { "Subreddit: r/${it.removePrefix("r/")}" }, "Upvotes")
        Platform.TWITTER -> Labels("Twitter", "Tweet", { "Author: $it" }, "Likes")
        Platform.YOUTUBE -> Labels("YouTube", "Video title", { "Channel: $it" }, null)
        Platform.INSTAGRAM -> Labels("Instagram", "Caption", { "Author: $it" }, "Likes")
        Platform.TIKTOK -> Labels("TikTok", "Caption", { "Creator: $it" }, "Likes")
    }

    private fun describe(post: Post): String {
        val l = labels(post.platform)
        val lines = mutableListOf(
            "Platform: ${l.name}" + if (post.media != Media.TEXT) " (${post.media.label})" else ""
        )
        val text = post.text.trim()
        lines += if (text.isNotEmpty()) "${l.content}: \"$text\"" else "(No ${l.content.lowercase()})"
        post.bodyText?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "Post text: \"$it\"" }
        lines += l.source(post.source)
        post.length?.let { lines += "Length: $it" }
        if (l.likes != null) {
            val likes = post.likes?.toString() ?: "(not yet visible)"
            lines += "${l.likes}: $likes" + (post.comments?.let { ", Comments: $it" } ?: "")
        }
        return lines.joinToString("\n")
    }

    private fun mediaNotes(posts: List<Post>): String {
        val notes = posts.map { it.media }.distinct().map { it.note }.filter { it.isNotEmpty() }
        return if (notes.isEmpty()) "" else "\n\n" + notes.joinToString("\n")
    }

    private fun themeSection(themes: List<Theme>): String {
        if (themes.isEmpty()) return ""
        val list = themes.mapIndexed { i, t -> "${i + 1}. \"${t.name}\": ${t.description}" }.joinToString("\n")
        return "\n\nAlso check whether each post matches any of these narrative themes:\n$list\n" +
            "Include \"narratives\" with the matching theme numbers, or [] if none match."
    }

    private fun fields(themes: List<Theme>): String =
        "\"hook\": <1-10>, \"effort\": <1-10>, \"pull\": <1-10>, \"value\": <1-10>, \"score\": <1-10>, " +
            "\"reason\": \"<15 words max: what grabs attention and what, if anything, it gives back>\"" +
            if (themes.isNotEmpty()) ", \"narratives\": [<theme numbers>]" else ""

    /** Pad with [withCalibration] first when the batch is small. */
    fun buildBatchPrompt(posts: List<Post>, themes: List<Theme> = emptyList(), adNote: Boolean = true): String {
        val list = posts.mapIndexed { i, p -> "[${i + 1}] ID: ${p.id}\n${describe(p)}" }.joinToString("\n\n")
        return "Rate each of these social media posts.\n\n$list\n\n" +
            RUBRIC + mediaNotes(posts) + (if (adNote) AD_NOTE else "") + themeSection(themes) +
            "\n\nRespond with ONLY valid JSON, one object per post in order, every object with all of these fields: " +
            "{\"results\": [{\"id\": \"<post ID>\", ${fields(themes)}}, ...]}"
    }

    // Scored alone, a post loses its sense of scale: a dense technical explainer rated 6-7 on
    // its own but 2-3 alongside other posts. Small batches are padded with these two fixed
    // posts, one at each end of the scale; their results are discarded.
    const val MIN_BATCH_FOR_CONTEXT = 3
    private const val CALIBRATION_PREFIX = "calibration-"
    private val CALIBRATION = listOf(
        "How TCP congestion control actually works, from slow start to BBR, with the equations and a worked example for each phase. Long thread, 1/14" to "netstack_notes",
        "They want you to forget what happened yesterday. I won't let them. Share before this gets taken down 😡👇" to "truth_daily_now",
    )

    fun isCalibrationId(id: String?): Boolean = id != null && id.startsWith(CALIBRATION_PREFIX)

    fun withCalibration(posts: List<Post>): List<Post> {
        if (posts.isEmpty() || posts.size >= MIN_BATCH_FOR_CONTEXT) return posts
        val platform = posts[0].platform
        val handle = platform == Platform.TWITTER || platform == Platform.INSTAGRAM || platform == Platform.TIKTOK
        return posts + CALIBRATION.mapIndexed { i, (text, source) ->
            Post(
                id = "$CALIBRATION_PREFIX${i + 1}",
                platform = platform,
                text = text,
                source = if (handle) "@$source" else source,
            )
        }
    }

    private fun rating(value: Any?): Int? =
        (value as? Number)?.toDouble()?.takeIf { it.isFinite() }?.roundToInt()?.coerceIn(1, 10)

    /** Sub-ratings from a parsed result item; null unless all four are present. */
    fun parseDims(item: Map<*, *>): Dims? {
        val hook = rating(item["hook"]) ?: return null
        val effort = rating(item["effort"]) ?: return null
        val pull = rating(item["pull"]) ?: return null
        val value = rating(item["value"]) ?: return null
        return Dims(hook, effort, pull, value)
    }

    // Fallback when the model leaves the score out. Fitted on the extension's scoring eval:
    // hook and value carry nearly all the signal.
    fun scoreFromDims(d: Dims): Int =
        (5 + 0.5 * (d.hook - 5) - 0.75 * (d.value - 5)).roundToInt().coerceIn(1, 10)

    /** The 1-10 score from a result item: the model's own, else from its sub-ratings. */
    fun readScore(item: Map<*, *>): Int? {
        val raw = item["score"]
        val n = when (raw) {
            is Number -> raw.toDouble()
            is String -> raw.trim().toDoubleOrNull()
            else -> null
        }
        if (n != null && n.isFinite()) return n.roundToInt().coerceIn(1, 10)
        return parseDims(item)?.let(::scoreFromDims)
    }

    /** Theme numbers (1-based) the model matched. */
    fun readNarratives(item: Map<*, *>): List<Int> =
        (item["narratives"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() ?: (it as? String)?.toIntOrNull() }
            ?: emptyList()
}
