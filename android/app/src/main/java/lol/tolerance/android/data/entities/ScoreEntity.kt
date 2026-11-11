package lol.tolerance.android.data.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "scores")
data class ScoreEntity(
    @PrimaryKey val postId: String,
    val apiScore: Int,          // 1-10 from LLM
    val reason: String,
    val cost: Double,
    val platform: String,
    val timestamp: Long = System.currentTimeMillis(),
)
