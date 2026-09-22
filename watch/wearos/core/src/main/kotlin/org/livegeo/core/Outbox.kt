package org.livegeo.core

// Fixes waiting to be sent. A watch loses signal all the time — a lift, a
// tunnel, a hike — and a fix taken then is still where somebody was. So
// nothing is sent directly: every fix goes in here, and the outbox is emptied
// in batches whenever the network allows, oldest first, with the times they
// were taken. The server files anything older than the live marker as
// history rather than moving the marker back.

/** Where the outbox survives the app being killed. The app backs it with a file. */
interface Shelf {
    fun load(): String?
    fun save(text: String)
}

class MemoryShelf : Shelf {
    var text: String? = null
    override fun load() = text
    override fun save(text: String) { this.text = text }
}

class Outbox(
    private val shelf: Shelf = MemoryShelf(),
    private val capacity: Int = 5_000,
    /** The server refuses anything older than a day, so it is not kept longer. */
    private val maxAgeSeconds: Long = 24 * 3600,
    private val batch: Int = 500,
) {
    private val waiting = ArrayDeque<Fix>()

    init {
        shelf.load()?.let { text -> text.lineSequence().mapNotNull(::decode).forEach { waiting.addLast(it) } }
    }

    val size get() = waiting.size

    fun add(fix: Fix) {
        waiting.addLast(fix)
        // Full: the oldest goes first. A recent fix says more about where
        // somebody is than one from yesterday morning.
        while (waiting.size > capacity) waiting.removeFirst()
        persist()
    }

    /**
     * Sends what is waiting through [send], a batch at a time, stopping at the
     * first failure so nothing is lost. Returns how many were delivered.
     */
    fun drain(now: Long, send: (List<Fix>) -> Result<*>): Result<Int> {
        waiting.removeAll { it.at < now - maxAgeSeconds }
        var delivered = 0
        while (waiting.isNotEmpty()) {
            val next = waiting.take(batch)
            val sent = send(next)
            if (sent.isFailure) {
                persist()
                return Result.failure(sent.exceptionOrNull()!!)
            }
            repeat(next.size) { waiting.removeFirst() }
            delivered += next.size
        }
        persist()
        return Result.success(delivered)
    }

    fun clear() {
        waiting.clear()
        persist()
    }

    private fun persist() = shelf.save(waiting.joinToString("\n", transform = ::encode))

    // One fix per line, fields separated by commas: small, and readable when
    // somebody has to look at the file to see why a watch is not reporting.
    private fun encode(f: Fix) = listOf(
        f.lat, f.lon, f.accuracy ?: "", f.heading ?: "", f.at, f.until ?: "", if (f.stopped) 1 else 0,
    ).joinToString(",")

    private fun decode(line: String): Fix? {
        val p = line.split(",")
        if (p.size != 7) return null
        return runCatching {
            Fix(
                lat = p[0].toDouble(),
                lon = p[1].toDouble(),
                accuracy = p[2].toDoubleOrNull(),
                heading = p[3].toDoubleOrNull(),
                at = p[4].toLong(),
                until = p[5].toLongOrNull(),
                stopped = p[6] == "1",
            )
        }.getOrNull()
    }
}
