package org.livegeo.core

// What the watch knows and says. The shapes mirror the server's own: a fix
// is what POST /api/ingest takes (see src/ingest.js), a person is one entry of
// GET /api/positions.

/** One reading from the watch's GPS. Times are seconds since the epoch. */
data class Fix(
    val lat: Double,
    val lon: Double,
    val accuracy: Double? = null,
    val heading: Double? = null,
    val at: Long,
    /** When this sharing session ends; the server caps it at a day. */
    val until: Long? = null,
    /** The last fix of a session: keeps the place, stops calling it live. */
    val stopped: Boolean = false,
)

/** Somebody on the map, as far as the watch's owner may see. */
data class Person(
    val id: String,
    val name: String,
    val lat: Double?,
    val lon: Double?,
    val accuracy: Double?,
    val at: Long,
    val live: Boolean,
)

data class Paired(val token: String, val deviceId: Long, val ownerId: String, val ownerName: String)

data class IngestResult(val accepted: Int, val rejected: List<Rejection>)
data class Rejection(val index: Int, val error: String)
