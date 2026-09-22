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
sealed class Failure(message: String) : Exception(message) {
    /** The token is no longer good: removed from the map, or /stop. Pair again. */
    class Unpaired : Failure("this watch is no longer paired")
    /** Wrong or expired pairing code. */
    class BadCode(message: String) : Failure(message)
    /** Too many wrong codes; wait, then ask for a new one. */
    class Limited(message: String) : Failure(message)
    /** No connection, or the server is unreachable. Worth retrying later. */
    class Offline(cause: Throwable) : Failure(cause.message ?: "offline")
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

    fun pair(code: String, name: String, platform: String): Result<Paired> = runCatching {
        val r = call("POST", "/api/devices/pair", Wire.pairRequest(code, name, platform), auth = false)
        when (r.status) {
            200 -> Wire.paired(r.body).also { token = it.token }
            404 -> throw Failure.BadCode(Wire.error(r.body) ?: "that code is wrong or has expired")
            else -> throw failFor(r)
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
