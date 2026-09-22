package org.livegeo.watch

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import org.livegeo.core.Api
import org.livegeo.core.Duration
import org.livegeo.core.Failure
import org.livegeo.core.Fix
import org.livegeo.core.HttpTransport
import org.livegeo.core.Outbox
import org.livegeo.core.Session
import org.livegeo.core.Shelf
import java.io.File

/** What the watch remembers between launches. Private to the app. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("livegeo", Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()

    var ownerId: String?
        get() = prefs.getString("owner.id", null)
        set(v) = prefs.edit().putString("owner.id", v).apply()

    var ownerName: String?
        get() = prefs.getString("owner.name", null)
        set(v) = prefs.edit().putString("owner.name", v).apply()

    fun session(): Session? {
        val start = prefs.getLong("session.start", -1)
        if (start < 0) return null
        val duration = runCatching { Duration.valueOf(prefs.getString("session.duration", "HOUR")!!) }
            .getOrDefault(Duration.HOUR)
        return Session(start, duration)
    }

    fun startSession(now: Long, duration: Duration) =
        prefs.edit().putLong("session.start", now).putString("session.duration", duration.name).apply()

    fun endSession() = prefs.edit().remove("session.start").remove("session.duration").apply()

    /** Forget the pairing: the token was refused, or the wearer asked. */
    fun unpair() = prefs.edit().clear().apply()
}

/** The outbox on disk, so fixes taken without signal survive the app being killed. */
class FileShelf(private val file: File) : Shelf {
    override fun load(): String? = if (file.exists()) file.readText() else null
    override fun save(text: String) {
        // Written beside and renamed over, so a kill mid-write cannot leave a
        // half-file that loses everything that was waiting.
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        tmp.renameTo(file)
    }
}

/** The pieces the screens and the service share, made once per process. */
object Livegeo {
    @Volatile private var api: Api? = null
    @Volatile private var outbox: Outbox? = null

    // The outbox is not thread-safe, so every touch of it happens on this
    // one thread: adding a fix and sending the queue cannot interleave.
    @OptIn(ExperimentalCoroutinesApi::class)
    val lane = Dispatchers.IO.limitedParallelism(1)

    fun api(context: Context): Api = api ?: synchronized(this) {
        api ?: Api(BuildConfig.SERVER, HttpTransport(), Store(context).token).also { api = it }
    }

    fun outbox(context: Context): Outbox = outbox ?: synchronized(this) {
        outbox ?: Outbox(FileShelf(File(context.filesDir, "outbox.txt"))).also { outbox = it }
    }

    fun now(): Long = System.currentTimeMillis() / 1000

    /** Queue a fix and try to send everything waiting. */
    suspend fun report(context: Context, fix: Fix) = withContext(lane) {
        outbox(context).add(fix)
        send(context)
    }

    /**
     * Send what is waiting. A refused token means this watch was removed, or
     * its owner sent /stop: nothing it holds is wanted any more, so the queue
     * and the pairing are both dropped and the screens go back to pairing.
     */
    suspend fun send(context: Context): Result<Int> = withContext(lane) {
        val box = outbox(context)
        val result = box.drain(now()) { api(context).report(it) }
        if (result.exceptionOrNull() is Failure.Unpaired) {
            box.clear()
            forget(context)
        }
        result
    }

    fun forget(context: Context) {
        Store(context).unpair()
        api(context).token = null
    }
}
