package lol.tolerance.android.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import lol.tolerance.android.data.entities.SessionEntity

@Dao
interface SessionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(session: SessionEntity)

    @Query("SELECT * FROM sessions ORDER BY startTime DESC LIMIT 1")
    suspend fun getLatest(): SessionEntity?

    @Query("SELECT * FROM sessions WHERE startTime BETWEEN :start AND :end ORDER BY startTime")
    suspend fun getInRange(start: Long, end: Long): List<SessionEntity>
}
