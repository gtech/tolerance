package lol.tolerance.android.api

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import lol.tolerance.android.ToleranceApp
import lol.tolerance.android.ui.settings.SettingsActivity

/**
 * Whether the scoring key has run out of credit or been refused — the extension's
 * apiErrorState. Set when OpenRouter refuses a scoring call (see [OpenRouterClient]),
 * cleared by the next call that succeeds or a new key.
 *
 * While exhausted, scoring is retried at most every [PROBE_INTERVAL_MS] rather than on every
 * screen, and unscored posts aren't held under covers. The free key's limit is monthly.
 */
class CreditMonitor(private val context: Context) {

    private val prefs = context.getSharedPreferences("tolerance_credits", Context.MODE_PRIVATE)

    fun isExhausted(): Boolean = prefs.getLong(KEY_SINCE, 0L) != 0L

    /** HTTP status of the refusal, while exhausted. */
    fun refusalStatus(): Int = prefs.getInt(KEY_STATUS, 0)

    /** Scoring may be attempted: credit is fine, or it's time for another try. */
    fun mayTry(now: Long = System.currentTimeMillis()): Boolean =
        !isExhausted() || now - prefs.getLong(KEY_LAST_TRY, 0L) >= PROBE_INTERVAL_MS

    fun recordTry(now: Long = System.currentTimeMillis()) {
        prefs.edit().putLong(KEY_LAST_TRY, now).apply()
    }

    /** Returns true if this starts a new exhausted spell (worth telling the user about). */
    fun markExhausted(status: Int): Boolean {
        val fresh = !isExhausted()
        prefs.edit()
            .putLong(KEY_SINCE, if (fresh) System.currentTimeMillis() else prefs.getLong(KEY_SINCE, 0L))
            .putInt(KEY_STATUS, status)
            .apply()
        if (fresh) Log.i(TAG, "Scoring key refused ($status): credits exhausted")
        return fresh
    }

    fun markWorking() {
        if (!isExhausted()) return
        Log.i(TAG, "Scoring key working again")
        prefs.edit().remove(KEY_SINCE).remove(KEY_STATUS).remove(KEY_LAST_TRY).apply()
        notifications().cancel(NOTIFICATION_ID)
    }

    /** One notification per exhausted spell, with the ways out. */
    fun notifyExhausted(freeTier: Boolean) {
        val (title, text) = if (freeTier) {
            "Free scoring credits used up" to
                "Tolerance can't score more posts on the free tier until next month. " +
                "Upgrade to Pro, or add your own OpenRouter key."
        } else {
            "OpenRouter refused your key" to
                "Scoring stopped (error ${refusalStatus()}). Check the key's credits and spend limit at openrouter.ai."
        }
        val upgrade = PendingIntent.getActivity(
            context, 0,
            Intent(Intent.ACTION_VIEW, Uri.parse(ACCOUNT_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val settings = PendingIntent.getActivity(
            context, 1,
            Intent(context, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, ToleranceApp.CHANNEL_ACCOUNT)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(settings)
            .apply { if (freeTier) addAction(0, "Upgrade to Pro", upgrade) }
            .addAction(0, if (freeTier) "Use own key" else "Settings", settings)
            .setAutoCancel(true)
            .build()
        try {
            notifications().notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "Notifications not permitted", e)
        }
    }

    private fun notifications() = context.getSystemService(NotificationManager::class.java)

    companion object {
        private const val TAG = "Tolerance.Credits"
        const val ACCOUNT_URL = "https://tolerance.lol/account.html"
        private const val PROBE_INTERVAL_MS = 15 * 60 * 1000L
        private const val NOTIFICATION_ID = 2002
        private const val KEY_SINCE = "exhausted_since"
        private const val KEY_STATUS = "refusal_status"
        private const val KEY_LAST_TRY = "last_try"
    }
}
