package lol.tolerance.android.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import lol.tolerance.android.data.entities.ScoreEntity

@Dao
interface ScoreDao {
    @Query("SELECT * FROM scores WHERE postId = :postId AND timestamp > :minTimestamp LIMIT 1")
    suspend fun getCached(postId: String, minTimestamp: Long): ScoreEntity?

    @Query("SELECT * FROM scores WHERE postId IN (:postIds) AND timestamp > :minTimestamp")
    suspend fun getCachedBatch(postIds: List<String>, minTimestamp: Long): List<ScoreEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(scores: List<ScoreEntity>)

    @Query("DELETE FROM scores WHERE timestamp < :cutoff")
    suspend fun deleteOlderThan(cutoff: Long)

    @Query("DELETE FROM scores")
    suspend fun clearAll()

    @Query("SELECT COUNT(*) FROM scores")
    suspend fun count(): Int
}
