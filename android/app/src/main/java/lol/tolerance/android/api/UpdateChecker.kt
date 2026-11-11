package lol.tolerance.android.api

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import lol.tolerance.android.BuildConfig
import lol.tolerance.android.ToleranceApp
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Sideloaded builds don't update themselves. Releases are published on GitHub
 * (gtech/tolerance, which also holds the extension's releases) as tags android-v<version>;
 * this finds the newest and says when it's newer than the running build. At most one
 * check a day, and one notification per version.
 */
class UpdateChecker(
    private val context: Context,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build(),
) {
    data class Release(val version: String, val pageUrl: String, val apkUrl: String?)

    private val prefs = context.getSharedPreferences("tolerance_updates", Context.MODE_PRIVATE)
    private val moshi = Moshi.Builder().build()

    /** The newest release if it's newer than this build, from cache unless a day has passed. */
    suspend fun availableUpdate(force: Boolean = false): Release? {
        if (!BuildConfig.GITHUB_UPDATES) return null
        val now = System.currentTimeMillis()
        val cached = cachedRelease()
        val latest = if (!force && now - prefs.getLong(KEY_CHECKED_AT, 0) < CHECK_INTERVAL_MS) cached
        else fetchLatest()?.also { save(it, now) } ?: cached
        return latest?.takeIf { isNewer(it.version, BuildConfig.VERSION_NAME) }
    }

    /** Check, and notify once per version found. */
    suspend fun checkAndNotify() {
        val update = availableUpdate() ?: return
        if (prefs.getString(KEY_NOTIFIED, null) == update.version) return
        prefs.edit().putString(KEY_NOTIFIED, update.version).apply()
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(Intent.ACTION_VIEW, Uri.parse(update.apkUrl ?: update.pageUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, ToleranceApp.CHANNEL_UPDATES)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Tolerance ${update.version} is available")
            .setContentText("Tap to download, then open it to install.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "Notifications not permitted", e)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private suspend fun fetchLatest(): Release? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Tolerance-Android/${BuildConfig.VERSION_NAME}")
            .build()
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "Release check failed: ${response.code}")
                    return@withContext null
                }
                val type = Types.newParameterizedType(List::class.java, Map::class.java)
                val releases = moshi.adapter<List<Map<String, Any?>>>(type).fromJson(response.body?.string().orEmpty())
                newestRelease(releases.orEmpty())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Release check failed", e)
            null
        }
    }

    private fun cachedRelease(): Release? {
        val version = prefs.getString(KEY_VERSION, null) ?: return null
        return Release(version, prefs.getString(KEY_PAGE, null) ?: return null, prefs.getString(KEY_APK, null))
    }

    private fun save(release: Release, now: Long) {
        prefs.edit()
            .putLong(KEY_CHECKED_AT, now)
            .putString(KEY_VERSION, release.version)
            .putString(KEY_PAGE, release.pageUrl)
            .putString(KEY_APK, release.apkUrl)
            .apply()
    }

    companion object {
        private const val TAG = "Tolerance.Updates"
        private const val RELEASES_URL = "https://api.github.com/repos/gtech/tolerance/releases?per_page=50"
        const val TAG_PREFIX = "android-v"
        private const val CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000L
        private const val NOTIFICATION_ID = 2003
        private const val KEY_CHECKED_AT = "checked_at"
        private const val KEY_VERSION = "latest_version"
        private const val KEY_PAGE = "latest_page"
        private const val KEY_APK = "latest_apk"
        private const val KEY_NOTIFIED = "notified_version"

        /** The newest published android-v* release in a GitHub releases listing. */
        fun newestRelease(releases: List<Map<String, Any?>>): Release? = releases
            .filter { it["draft"] != true && it["prerelease"] != true }
            .mapNotNull { r ->
                val tag = r["tag_name"] as? String ?: return@mapNotNull null
                if (!tag.startsWith(TAG_PREFIX)) return@mapNotNull null
                val apk = (r["assets"] as? List<*>)?.filterIsInstance<Map<*, *>>()
                    ?.firstOrNull { (it["name"] as? String)?.endsWith(".apk") == true }
                    ?.get("browser_download_url") as? String
                Release(tag.removePrefix(TAG_PREFIX), r["html_url"] as? String ?: return@mapNotNull null, apk)
            }
            .maxWithOrNull { a, b -> compareVersions(a.version, b.version) }

        /** "1.2.0" is newer than "1.1.9" and "1.1.9-staging". */
        fun isNewer(candidate: String, current: String): Boolean = compareVersions(candidate, current) > 0

        private fun compareVersions(a: String, b: String): Int {
            val x = numbers(a)
            val y = numbers(b)
            for (i in 0 until maxOf(x.size, y.size)) {
                val diff = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
                if (diff != 0) return diff
            }
            return 0
        }

        /** "1.0.0-play" → [1, 0, 0]; suffixes name the build, not the version */
        private fun numbers(version: String): List<Int> =
            version.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    }
}
