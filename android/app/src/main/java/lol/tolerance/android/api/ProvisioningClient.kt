package lol.tolerance.android.api

import android.util.Log
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Provisions a free-tier API key from api.tolerance.lol.
 * Mirrors the extension's provisioning.ts logic.
 */
class ProvisioningClient(
    private val keyStore: KeyStore,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build(),
) {
    private val moshi = Moshi.Builder().build()

    @JsonClass(generateAdapter = true)
    data class ProvisionRequest(val installId: String)

    @JsonClass(generateAdapter = true)
    data class ProvisionResponse(
        val apiKey: String?,
        val monthlyLimit: Double?,
        val variant: String?,
        val error: String?,
    )

    /**
     * Provisions or retrieves an existing free-tier key.
     * Returns the API key, or null on failure.
     */
    suspend fun provisionFreeKey(): String? = withContext(Dispatchers.IO) {
        // Already have a key?
        keyStore.apiKey?.let { return@withContext it }

        val installId = keyStore.installId
        val json = moshi.adapter(ProvisionRequest::class.java)
            .toJson(ProvisionRequest(installId))

        val request = Request.Builder()
            .url("$BASE_URL/api/free/provision-key")
            .post(json.toRequestBody(JSON_MEDIA_TYPE))
            .header("Content-Type", "application/json")
            .build()

        try {
            val response = http.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext null

            if (!response.isSuccessful) {
                Log.w(TAG, "Provisioning failed: ${response.code} $body")
                return@withContext null
            }

            val result = moshi.adapter(ProvisionResponse::class.java).fromJson(body)
            result?.apiKey?.also { key ->
                keyStore.apiKey = key
                Log.d(TAG, "Provisioned free key, variant=${result.variant}, limit=${result.monthlyLimit}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Provisioning error", e)
            null
        }
    }

    companion object {
        private const val TAG = "Tolerance.Provision"
        private const val BASE_URL = "https://api.tolerance.lol"
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
