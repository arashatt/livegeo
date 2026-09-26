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
import org.livegeo.core.Links
import org.livegeo.core.Outbox
import org.livegeo.core.Session
import org.livegeo.core.Shelf
import java.io.File
import java.util.UUID

/** What the watch remembers between launches. Private to the app. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("livegeo", Context.MODE_PRIVATE)

    /**
     * The map this watch belongs to: the one found from the name /pair gave
     * when it paired, or the one built into this app, if it has one.
     */
    var server: String?
        get() = prefs.getString("server", null) ?: BUILT_IN
        set(v) = prefs.edit().putString("server", v).apply()

    /**
     * This installation's own random id, made once and kept through unpairing:
     * sent when pairing, so pairing again after the map moved replaces this
     * watch's old entry rather than leaving its old token working (Api.pair).
     */
    val install: String
        get() = prefs.getString("install", null)
            ?: UUID.randomUUID().toString().replace("-", "").also { prefs.edit().putString("install", it).apply() }

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

    /**
     * Paired: which map, the token, and whose watch it is, written together,
     * so nothing sending in the background meanwhile sees the new map with the
     * old token, or the other way round.
     */
    fun paired(server: String, token: String, ownerId: String, ownerName: String) = prefs.edit()
        .putString("server", server).putString("token", token)
        .putString("owner.id", ownerId).putString("owner.name", ownerName)
        .apply()

    /**
     * Forget the pairing: the token was refused, or the wearer asked. Which
     * map, and which installation this is, stay: pairing again is then just
     * the code.
     */
    fun unpair() = prefs.edit()
        .remove("token").remove("owner.id").remove("owner.name")
        .remove("session.start").remove("session.duration")
        .apply()

    companion object {
        /** The map built into this app, or null: a build without one asks for it when pairing. */
        val BUILT_IN: String? = Links.origin(BuildConfig.SERVER)?.takeUnless { "example." in it }
    }
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
    @Volatile private var apiBase: String? = null
    @Volatile private var outbox: Outbox? = null

    // The outbox is not thread-safe, so every touch of it happens on this
    // one thread: adding a fix and sending the queue cannot interleave.
    @OptIn(ExperimentalCoroutinesApi::class)
    val lane = Dispatchers.IO.limitedParallelism(1)

    /**
     * The client for the map this watch is paired with, made again when the
     * map or the token changes: pairing again after the map moved changes
     * both.
     */
    fun api(context: Context): Api = synchronized(this) {
        val store = Store(context)
        val base = store.server.orEmpty()
        val token = store.token
        val current = api
        if (current != null && apiBase == base && current.token == token) return current
        Api(base, HttpTransport(), token).also { api = it; apiBase = base }
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
     * Unless it paired again meanwhile, after the map moved, and what was
     * refused was the token it had before.
     */
    suspend fun send(context: Context): Result<Int> = withContext(lane) {
        val box = outbox(context)
        val client = api(context)
        val result = box.drain(now()) { client.report(it) }
        if (result.exceptionOrNull() is Failure.Unpaired && client.token == Store(context).token) {
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
