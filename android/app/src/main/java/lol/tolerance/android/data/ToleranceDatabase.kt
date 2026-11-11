package lol.tolerance.android.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import lol.tolerance.android.data.dao.ScoreDao
import lol.tolerance.android.data.entities.ScoreEntity

// Version 1 is the scores table alone, as shipped in 1.0.0. Any change to the tables needs a
// new version and a migration: Room refuses to open a database whose schema doesn't match,
// and then nothing gets scored.
@Database(
    entities = [ScoreEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class ToleranceDatabase : RoomDatabase() {
    abstract fun scoreDao(): ScoreDao

    companion object {
        fun create(context: Context): ToleranceDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                ToleranceDatabase::class.java,
                "tolerance.db"
            ).build()
    }
}
