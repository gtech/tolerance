package lol.tolerance.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import lol.tolerance.android.data.ToleranceDatabase

class ToleranceApp : Application() {

    lateinit var database: ToleranceDatabase
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        database = ToleranceDatabase.create(this)
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val serviceChannel = NotificationChannel(
            CHANNEL_SERVICE,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notification_channel_description)
        }

        val phaseChannel = NotificationChannel(
            CHANNEL_PHASE,
            getString(R.string.notification_phase_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        )

        val accountChannel = NotificationChannel(
            CHANNEL_ACCOUNT,
            "Scoring credits",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "When scoring stops because the API key ran out of credit"
        }

        val updatesChannel = NotificationChannel(
            CHANNEL_UPDATES,
            "Updates",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "When a new version of Tolerance is available to download"
        }

        manager.createNotificationChannel(serviceChannel)
        manager.createNotificationChannel(phaseChannel)
        manager.createNotificationChannel(accountChannel)
        if (BuildConfig.GITHUB_UPDATES) manager.createNotificationChannel(updatesChannel)
    }

    companion object {
        const val CHANNEL_SERVICE = "tolerance_service"
        const val CHANNEL_PHASE = "tolerance_phase"
        const val CHANNEL_ACCOUNT = "tolerance_account"
        const val CHANNEL_UPDATES = "tolerance_updates"

        lateinit var instance: ToleranceApp
            private set
    }
}
