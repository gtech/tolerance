package lol.tolerance.android.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import lol.tolerance.android.data.dao.ScoreDao
import lol.tolerance.android.data.dao.SessionDao
import lol.tolerance.android.data.entities.ScoreEntity
import lol.tolerance.android.data.entities.SessionEntity

@Database(
    entities = [ScoreEntity::class, SessionEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class ToleranceDatabase : RoomDatabase() {
    abstract fun scoreDao(): ScoreDao
    abstract fun sessionDao(): SessionDao

    companion object {
        fun create(context: Context): ToleranceDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                ToleranceDatabase::class.java,
                "tolerance.db"
            ).build()
    }
}
