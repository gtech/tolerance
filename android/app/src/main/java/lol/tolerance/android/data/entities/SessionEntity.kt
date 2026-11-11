package lol.tolerance.android.data.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val sessionId: String,
    val startTime: Long,
    val endTime: Long?,
    val platform: String,
    val postsScored: Int,
    val totalMinutes: Double,
    val maxPhase: String,   // "normal", "reduced", "wind-down", "minimal"
)
