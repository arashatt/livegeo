package org.livegeo.core

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// The four things the watch asks the server. HttpURLConnection because it is
// the one HTTP client that exists both on Android and on a plain JVM, where
// the tests run; java.net.http does not exist on Android at all.

data class HttpResponse(val status: Int, val body: String)

fun interface Transport {
    @Throws(IOException::class)
    fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse
}

class HttpTransport(private val timeoutMs: Int = 20_000) : Transport {
    override fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val status = c.responseCode
            val stream = if (status < 400) c.inputStream else c.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return HttpResponse(status, text)
        } finally {
            c.disconnect()
        }
    }
}

/** What went wrong, in terms the screens can act on. */
sealed class Failure(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** The token is no longer good: removed from the map, or /stop. Pair again. */
    class Unpaired : Failure("this watch is no longer paired")
    /** Wrong or expired pairing code. */
    class BadCode(message: String) : Failure(message)
    /** Too many wrong codes; wait, then ask for a new one. */
    class Limited(message: String) : Failure(message)
    /** No connection, or the server is unreachable. Worth retrying later. */
    class Offline(cause: Throwable) : Failure(cause.message ?: "offline", cause)
    class Server(val status: Int, message: String) : Failure(message)
}

class Api(
    base: String,
    private val transport: Transport = HttpTransport(),
    var token: String? = null,
) {
    private val root = base.trimEnd('/')

    private fun call(method: String, path: String, body: String? = null, auth: Boolean = true): HttpResponse {
        val headers = buildMap {
            put("accept", "application/json")
            if (auth) token?.let { put("authorization", "Bearer $it") }
        }
        return try {
            transport.send(method, root + path, headers, body)
        } catch (e: IOException) {
            throw Failure.Offline(e)
        }
    }

    private fun failFor(r: HttpResponse): Failure {
        val said = Wire.error(r.body) ?: "HTTP ${r.status}"
        return when (r.status) {
            401 -> Failure.Unpaired()
            429 -> Failure.Limited(said)
            else -> Failure.Server(r.status, said)
        }
    }

    /**
     * Pairs with a code from /pair. [install] is this installation's own
     * random id: the same one pairing again, after the map's address changed,
     * replaces the entry it had instead of leaving its old token working.
     */
    fun pair(code: String, name: String, platform: String, install: String? = null): Result<Paired> = runCatching {
        val r = call("POST", "/api/devices/pair", Wire.pairRequest(code, name, platform, install), auth = false)
        when (r.status) {
            200 -> Wire.paired(r.body).also { token = it.token }
            404 -> throw Failure.BadCode(Wire.error(r.body) ?: "that code is wrong or has expired")
            else -> throw failFor(r)
        }
    }

    /**
     * Whether this address is a LiveGeo map, asked before it is remembered as
     * one: a link to anything else (the download page the app came from, say)
     * must not become the map the app opens every time.
     */
    fun probe(): Probe {
        val r = try {
            transport.send("GET", "$root/healthz", mapOf("accept" to "application/json"), null)
        } catch (e: IOException) {
            return Probe.UNREACHABLE
        }
        return when {
            r.status == 200 && Wire.isHealth(r.body) -> Probe.MAP
            r.status >= 500 -> Probe.UNREACHABLE
            else -> Probe.NOT_MAP
        }
    }

    /**
     * A pairing code for whoever [cookie] signs in as. The phone app is
     * already signed in to the map in its web view, so it pairs itself with
     * that session instead of having six digits read off one screen and
     * typed into another. The session cookie goes to this one call only.
     */
    fun code(cookie: String): Result<String> = runCatching {
        val headers = mapOf("accept" to "application/json", "cookie" to cookie)
        val r = try {
            transport.send("POST", "$root/api/devices/code", headers, "{}")
        } catch (e: IOException) {
            throw Failure.Offline(e)
        }
        when (r.status) {
            200 -> Wire.code(r.body)
            401, 403 -> throw Failure.Server(r.status, "sign in to the map first")
            404 -> throw Failure.Server(404, Wire.error(r.body)?.takeIf { it != "not found" }
                ?: "this map cannot pair devices for this sign-in")
            429 -> throw Failure.Limited(Wire.error(r.body) ?: "too many tries, wait a little")
            else -> throw Failure.Server(r.status, Wire.error(r.body) ?: "HTTP ${r.status}")
        }
    }

    /**
     * Who [cookie] signs in as, or null when it is not a person (the shared
     * dashboard token). The phone checks this before going live, so a phone
     * paired while one person was signed in never reports as them for
     * somebody else.
     */
    fun whoIs(cookie: String): Result<String?> = runCatching {
        val headers = mapOf("accept" to "application/json", "cookie" to cookie)
        val r = try {
            transport.send("GET", "$root/api/me", headers, null)
        } catch (e: IOException) {
            throw Failure.Offline(e)
        }
        when (r.status) {
            200 -> Wire.id(r.body)
            401, 403 -> throw Failure.Server(r.status, "sign in to the map first")
            else -> throw Failure.Server(r.status, Wire.error(r.body) ?: "HTTP ${r.status}")
        }
    }

    fun report(fixes: List<Fix>): Result<IngestResult> = runCatching {
        val r = call("POST", "/api/ingest", Wire.fixes(fixes))
        if (r.status == 200) Wire.ingest(r.body) else throw failFor(r)
    }

    fun people(): Result<List<Person>> = runCatching {
        val r = call("GET", "/api/positions")
        if (r.status == 200) Wire.people(r.body) else throw failFor(r)
    }

    /** A map tile, through the server's own tile proxy: no Maps API key. */
    fun tileUrl(z: Int, x: Int, y: Int): String = "$root/tiles/$z/$x/$y.png"

    fun authHeader(): Map<String, String> = token?.let { mapOf("authorization" to "Bearer $it") } ?: emptyMap()
}
