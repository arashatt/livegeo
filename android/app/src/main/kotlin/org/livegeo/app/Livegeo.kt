package org.livegeo.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
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

/** What the app remembers between launches. Private to the app. */
class Store(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("livegeo", Context.MODE_PRIVATE)

    /**
     * The map's origin, from the last link whose address answered as a
     * LiveGeo map, or could not be asked (MainActivity.open). Never a website
     * that answered as something else.
     */
    var server: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()

    /** The bot's username, read off the map's own pages: where "Open Telegram" goes. */
    var bot: String?
        get() = prefs.getString("bot", null)
        set(v) = prefs.edit().putString("bot", v).apply()

    /** This device's token, once paired: how its fixes reach the map as its owner's. */
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

    /** Forget the pairing, and any sharing with it. Where the map is stays known. */
    fun unpair() = prefs.edit()
        .remove("token").remove("owner.id").remove("owner.name")
        .remove("session.start").remove("session.duration")
        .apply()
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

/** The pieces the screen and the location service share, made once per process. */
object Livegeo {
    @Volatile private var api: Api? = null
    @Volatile private var apiBase: String? = null
    @Volatile private var outbox: Outbox? = null

    // The outbox is not thread-safe, so every touch of it happens on this one
    // thread: adding a fix and sending the queue cannot interleave.
    @OptIn(ExperimentalCoroutinesApi::class)
    val lane = Dispatchers.IO.limitedParallelism(1)

    /** For work that must finish even when whoever started it is gone: the last fix of a session. */
    val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Told, on the main thread, whenever sharing starts or stops: the open map's button follows it. */
    @Volatile var onChange: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())

    fun changed() {
        main.post { onChange?.invoke() }
    }

    /** The client for the map as it is now. Its address can change; the device token does not. */
    fun api(context: Context): Api = synchronized(this) {
        val store = Store(context)
        val base = store.server.orEmpty()
        val current = api
        if (current != null && apiBase == base) return current
        Api(base, HttpTransport(), store.token).also { api = it; apiBase = base }
    }

    fun outbox(context: Context): Outbox = outbox ?: synchronized(this) {
        outbox ?: Outbox(FileShelf(File(context.filesDir, "outbox.txt"))).also { outbox = it }
    }

    fun now(): Long = System.currentTimeMillis() / 1000

    /** Sharing, if it is on and has not run out. */
    fun sharing(context: Context): Session? = Store(context).session()?.takeIf { it.active(now()) }

    /** Queue a fix and try to send everything waiting. */
    suspend fun report(context: Context, fix: Fix): Result<Int> = withContext(lane) {
        outbox(context).add(fix)
        send(context)
    }

    /**
     * Send what is waiting. A refused token means this device was removed
     * from the map, or its owner sent /stop: nothing it holds is wanted any
     * more, so the queue and the pairing both go.
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

    /**
     * Make sure this device reports as the person [cookie] signs in as: the
     * web view's own session. Paired already, to them: nothing to do. Paired
     * to somebody else, or not at all: a code is asked for with the session
     * and redeemed at once, so nobody types six digits. Offline and already
     * paired, it carries on: fixes wait in the outbox until the network is back.
     */
    suspend fun ensurePaired(context: Context, cookie: String): Result<Unit> = withContext(lane) {
        runCatching {
            val store = Store(context)
            val api = api(context)
            val person = api.whoIs(cookie).getOrElse { e ->
                if (e is Failure.Offline && store.token != null) return@runCatching
                throw e
            }
            if (store.token != null && person != null && person == store.ownerId) {
                api.token = store.token
                return@runCatching
            }
            val code = api.code(cookie).getOrThrow()
            val paired = api.pair(code, deviceName(), "android").getOrThrow()
            store.token = paired.token
            store.ownerId = paired.ownerId
            store.ownerName = paired.ownerName
            // Anything queued belonged to the pairing before.
            outbox(context).clear()
        }
    }

    fun forget(context: Context) {
        Store(context).unpair()
        api?.token = null
        changed()
    }

    /** "Samsung SM-A515F": how this device is listed among its owner's devices on the map. */
    fun deviceName(): String {
        val maker = Build.MANUFACTURER.orEmpty().trim().replaceFirstChar { it.titlecase() }
        val model = Build.MODEL.orEmpty().trim()
        val name = if (maker.isEmpty() || model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        return name.trim().take(40).ifEmpty { "Android" }
    }
}
