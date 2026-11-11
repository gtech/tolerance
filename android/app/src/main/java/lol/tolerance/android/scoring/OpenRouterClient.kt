package lol.tolerance.android.scoring

import android.util.Log
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import lol.tolerance.android.BuildConfig
import lol.tolerance.android.api.KeyStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** OpenRouter refused the key itself (see OpenRouterClient.isKeyRefusal). */
class KeyRefusedException(val status: Int) : Exception("Key refused: HTTP $status")

/**
 * OpenRouter API client for scoring posts.
 * Ports the batch scoring call from extension/src/background/openrouter.ts; the prompt
 * itself comes from [ScoringSpec].
 */
class OpenRouterClient(
    private val keyStore: KeyStore,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build(),
) {
    private val moshi = Moshi.Builder().build()

    data class ScoreResult(
        val postId: String,
        val score: Int,   // 1-10
        val reason: String,
        val dims: ScoringSpec.Dims?,
        val narratives: List<Int>, // 1-based indexes into the themes sent
        val cost: Double,
    )

    /**
     * Score a batch of posts in a single API call, padded with calibration posts when small.
     * Returns a map of post id -> ScoreResult; posts the model skipped are missing.
     * @throws KeyRefusedException when the key is out of credit or invalid
     */
    suspend fun scoreBatch(
        posts: List<ScoringSpec.Post>,
        themes: List<ScoringSpec.Theme> = emptyList(),
    ): Map<String, ScoreResult> = withContext(Dispatchers.IO) {
        if (posts.isEmpty()) return@withContext emptyMap()

        val apiKey = keyStore.getEffectiveApiKey()
        if (apiKey.isNullOrBlank()) {
            Log.w(TAG, "No API key configured")
            return@withContext emptyMap()
        }

        // The Play build doesn't ask the model to single out ads either
        val prompt = ScoringSpec.buildBatchPrompt(ScoringSpec.withCalibration(posts), themes, adNote = BuildConfig.AD_BLOCKING)
        val request = Request.Builder()
            .url(ENDPOINT)
            .post(buildRequestBody(prompt).toRequestBody(JSON_MEDIA_TYPE))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $apiKey")
            .header("HTTP-Referer", "android-app://lol.tolerance.android")
            .header("X-Title", "Tolerance Android")
            .build()

        val (code, body) = try {
            http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() }
        } catch (e: Exception) {
            Log.e(TAG, "Scoring failed", e)
            return@withContext emptyMap()
        }
        if (code !in 200..299) {
            Log.w(TAG, "API error: $code ${body.take(200)}")
            if (isKeyRefusal(code, body)) throw KeyRefusedException(code)
            return@withContext emptyMap()
        }
        parseBatchResponse(body, posts)
    }

    /** The key's spend limit and what's left of it, or why it couldn't be read. */
    sealed interface KeyCheck {
        /** limit and remaining are null when the key has no spend limit. In USD. */
        data class Ok(val limit: Double?, val remaining: Double?) : KeyCheck
        data class Refused(val status: Int) : KeyCheck
        data object Failed : KeyCheck
    }

    /** OpenRouter's own record of [apiKey]: it works, and how much credit it has left. */
    @Suppress("UNCHECKED_CAST")
    suspend fun checkKey(apiKey: String): KeyCheck = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(KEY_ENDPOINT)
            .header("Authorization", "Bearer $apiKey")
            .build()
        try {
            http.newCall(request).execute().use { response ->
                if (response.code == 401 || response.code == 403) return@withContext KeyCheck.Refused(response.code)
                if (!response.isSuccessful) return@withContext KeyCheck.Failed
                val json = moshi.adapter<Map<String, Any>>(
                    Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)
                ).fromJson(response.body?.string().orEmpty())
                val data = json?.get("data") as? Map<String, Any> ?: return@withContext KeyCheck.Failed
                KeyCheck.Ok(
                    limit = (data["limit"] as? Number)?.toDouble(),
                    remaining = (data["limit_remaining"] as? Number)?.toDouble(),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Key check failed", e)
            KeyCheck.Failed
        }
    }


    private fun buildRequestBody(prompt: String): String {
        val body = mapOf(
            "model" to TEXT_MODEL,
            "messages" to listOf(mapOf("role" to "user", "content" to prompt)),
            // A 10-post batch with sub-ratings needs well over 1000 tokens
            "max_tokens" to 8000,
            "stream" to false,
            "temperature" to 0.3,
            // Haiku thinks by default; scoring doesn't need it (~8s a batch vs ~3.6s)
            "reasoning" to mapOf("enabled" to false),
            "response_format" to mapOf("type" to "json_object"),
        )
        return moshi.adapter<Any>(Any::class.java).toJson(body)
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseBatchResponse(
        responseBody: String,
        posts: List<ScoringSpec.Post>,
    ): Map<String, ScoreResult> {
        val results = mutableMapOf<String, ScoreResult>()

        try {
            val responseMap = moshi.adapter<Map<String, Any>>(
                Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)
            ).fromJson(responseBody) ?: return emptyMap()

            val choices = responseMap["choices"] as? List<Map<String, Any>> ?: return emptyMap()
            val message = choices.firstOrNull()?.get("message") as? Map<String, Any> ?: return emptyMap()
            var content = message["content"] as? String ?: return emptyMap()

            // Strip markdown code blocks if present
            val codeBlockRegex = Regex("```(?:json)?\\s*([\\s\\S]*?)```")
            codeBlockRegex.find(content)?.let {
                content = it.groupValues[1].trim()
            }

            val items = parseResultItems(content) ?: run {
                Log.w(TAG, "Unparseable reply: ${content.take(200)}")
                return emptyMap()
            }

            val usage = responseMap["usage"] as? Map<String, Any>
            val inputTokens = (usage?.get("prompt_tokens") as? Number)?.toInt() ?: 0
            val outputTokens = (usage?.get("completion_tokens") as? Number)?.toInt() ?: 0
            val totalCost = (inputTokens / 1_000_000.0) * COST_PER_M_INPUT +
                (outputTokens / 1_000_000.0) * COST_PER_M_OUTPUT
            val costPerPost = totalCost / posts.size

            val ids = posts.map { it.id }.toSet()
            for ((i, raw) in items.withIndex()) {
                val item = raw as? Map<*, *> ?: continue
                val itemId = (item["id"] ?: item["postId"] ?: item["post_id"])?.toString()?.trim()
                if (ScoringSpec.isCalibrationId(itemId)) continue
                // Fall back to position: calibration posts are appended after the real ones
                val postId = itemId?.takeIf { it in ids } ?: posts.getOrNull(i)?.id ?: continue
                val score = ScoringSpec.readScore(item) ?: continue
                results[postId] = ScoreResult(
                    postId = postId,
                    score = score,
                    reason = (item["reason"] as? String).orEmpty(),
                    dims = ScoringSpec.parseDims(item),
                    narratives = ScoringSpec.readNarratives(item),
                    cost = costPerPost,
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse batch response", e)
        }

        return results
    }

    /** The result items from a reply: {"results": [...]}, a bare array, or a single object. */
    @Suppress("UNCHECKED_CAST")
    private fun parseResultItems(content: String): List<Any>? {
        val any = moshi.adapter<Any>(Any::class.java).lenient()
        val parsed = try { any.fromJson(content) } catch (_: Exception) { null }
            ?: Regex("\\{[\\s\\S]*\\}").find(content)?.let { m ->
                // Prose around the JSON. Android's ICU regex rejects unescaped } and ].
                try { any.fromJson(m.value) } catch (_: Exception) { null }
            }
        return when (parsed) {
            is List<*> -> parsed as List<Any>
            is Map<*, *> -> (parsed["results"] ?: parsed["data"]) as? List<Any>
                ?: if (parsed.containsKey("score")) listOf(parsed) else null
            else -> null
        }
    }

    companion object {
        private const val TAG = "Tolerance.OpenRouter"
        private const val ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
        private const val KEY_ENDPOINT = "https://openrouter.ai/api/v1/key"
        // The extension's default since Nov 2026: 52/53 in range on its scoring eval,
        // 10-post batches ~3.6s with thinking off
        private const val TEXT_MODEL = "anthropic/claude-haiku-5.5"
        // USD per 1M tokens
        private const val COST_PER_M_INPUT = 0.1
        private const val COST_PER_M_OUTPUT = 0.5
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()

        /**
         * The key itself was refused: out of credit (402), over its limit (403/429), or not a
         * valid key (401). A 429 from the model's provider ("rate-limited upstream") is
         * transient and says nothing about the key — the extension makes the same split.
         */
        internal fun isKeyRefusal(code: Int, body: String): Boolean = when (code) {
            401, 402, 403 -> true
            429 -> !Regex("upstream|provider returned error", RegexOption.IGNORE_CASE).containsMatchIn(body)
            else -> false
        }
    }
}
