package lol.tolerance.android.service

import android.content.Context
import android.media.AudioManager
import android.util.Log

/**
 * Mutes media playback while a covered video plays underneath (TikTok autoplays with sound,
 * so a cover alone doesn't hide it). Only undoes its own mute: if media was already muted
 * when we'd have muted it, it's left alone both ways. Main thread only.
 */
class MediaMute(context: Context) {

    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var mutedByUs = false

    fun set(mute: Boolean) {
        if (mute == mutedByUs) return
        try {
            if (mute) {
                if (audio.isStreamMute(STREAM)) return
                audio.adjustStreamVolume(STREAM, AudioManager.ADJUST_MUTE, 0)
            } else {
                audio.adjustStreamVolume(STREAM, AudioManager.ADJUST_UNMUTE, 0)
            }
            mutedByUs = mute
        } catch (e: SecurityException) {
            // Do Not Disturb can refuse volume changes
            Log.w(TAG, "Couldn't ${if (mute) "mute" else "unmute"} media", e)
        }
    }

    companion object {
        private const val TAG = "Tolerance.Mute"
        private const val STREAM = AudioManager.STREAM_MUSIC
    }
}
