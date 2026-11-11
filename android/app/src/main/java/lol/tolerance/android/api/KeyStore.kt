package lol.tolerance.android.api

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Securely stores the OpenRouter API key and install ID
 * using EncryptedSharedPreferences.
 *
 * Uses a singleton pattern to avoid multiple EncryptedSharedPreferences
 * instances which can cause corruption.
 */
class KeyStore private constructor(context: Context) {

    private val prefs: SharedPreferences

    init {
        val appContext = context.applicationContext
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            appContext,
            "tolerance_keys",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var apiKey: String?
        get() = prefs.getString(KEY_API_KEY, null)
        set(value) { prefs.edit().putString(KEY_API_KEY, value).commit() }

    var installId: String
        get() = prefs.getString(KEY_INSTALL_ID, null) ?: run {
            val id = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_INSTALL_ID, id).commit()
            Log.d(TAG, "Generated new install ID: ${id.take(8)}...")
            id
        }
        set(value) { prefs.edit().putString(KEY_INSTALL_ID, value).commit() }

    var apiTier: String
        get() = prefs.getString(KEY_API_TIER, "free") ?: "free"
        set(value) { prefs.edit().putString(KEY_API_TIER, value).commit() }

    var ownApiKey: String?
        get() = prefs.getString(KEY_OWN_API_KEY, null)
        set(value) { prefs.edit().putString(KEY_OWN_API_KEY, value).commit() }

    /** Returns the effective API key — own key if set, otherwise provisioned free key. */
    fun getEffectiveApiKey(): String? =
        if (apiTier == "own-key") ownApiKey else apiKey

    fun isConfigured(): Boolean = getEffectiveApiKey()?.isNotBlank() == true

    companion object {
        private const val TAG = "Tolerance.KeyStore"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_INSTALL_ID = "install_id"
        private const val KEY_API_TIER = "api_tier"
        private const val KEY_OWN_API_KEY = "own_api_key"

        @Volatile
        private var instance: KeyStore? = null

        fun getInstance(context: Context): KeyStore {
            return instance ?: synchronized(this) {
                instance ?: KeyStore(context).also { instance = it }
            }
        }
    }
}
