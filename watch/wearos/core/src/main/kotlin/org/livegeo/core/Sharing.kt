package org.livegeo.core

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

// Sharing sessions, when to send, and the arithmetic the screens need. All
// pure, so the rules that decide battery life are tested rather than hoped.

/** How long to share: an hour, four, or until the wearer stops it. */
enum class Duration(val seconds: Long?) { HOUR(3600), FOUR_HOURS(4 * 3600), UNTIL_STOPPED(null) }

class Session(val startedAt: Long, val duration: Duration) {
    /** When it ends, or null for "until I stop". */
    val until: Long? = duration.seconds?.let { startedAt + it }
    fun active(now: Long) = until == null || now < until
    fun remaining(now: Long): Long? = until?.let { max(0, it - now) }
}

object Geo {
    /** Great-circle metres — the same formula the server uses. */
    fun metres(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val rad = PI / 180
        val dLat = (lat2 - lat1) * rad
        val dLon = (lon2 - lon1) * rad
        val s = sin(dLat / 2).pow(2) + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLon / 2).pow(2)
        return 2 * 6_371_000 * asin(min(1.0, sqrt(s)))
    }
}

/**
 * Whether a new fix is worth sending. The server filters noise anyway, but
 * every send is radio time, and radio time is the battery. So: moved further
 * than the fix's own uncertainty (never less than [minMetres]), or quiet for
 * [heartbeatSeconds] — which keeps somebody standing still showing as live
 * instead of expiring off the map.
 */
object Cadence {
    fun worthSending(
        last: Fix?,
        next: Fix,
        minMetres: Double = 25.0,
        heartbeatSeconds: Long = 300,
    ): Boolean {
        if (last == null || next.stopped) return true
        if (next.at - last.at >= heartbeatSeconds) return true
        val threshold = max(minMetres, max(last.accuracy ?: 0.0, next.accuracy ?: 0.0))
        return Geo.metres(last.lat, last.lon, next.lat, next.lon) > threshold
    }
}

object Words {
    fun distance(metres: Double): String = when {
        metres < 1000 -> "${(metres / 10).roundToInt() * 10} m"
        metres < 10_000 -> "${"%.1f".format(metres / 1000)} km"
        else -> "${(metres / 1000).roundToInt()} km"
    }

    fun ago(seconds: Long): String = when {
        seconds < 60 -> "now"
        seconds < 3600 -> "${seconds / 60} min ago"
        seconds < 86_400 -> "${seconds / 3600} h ago"
        else -> "${seconds / 86_400} d ago"
    }

    fun remaining(seconds: Long): String = when {
        seconds >= 3600 -> "${seconds / 3600} h ${(seconds % 3600) / 60} min left"
        else -> "${max(1, seconds / 60)} min left"
    }

    /** "482 913": six digits read more easily in two groups. */
    fun code(digits: String): String = if (digits.length > 3) digits.take(3) + " " + digits.drop(3) else digits
}

/**
 * Slippy-map arithmetic for drawing tiles from the server's /tiles proxy:
 * which tile a point is in, and where inside it.
 */
object Tiles {
    data class Spot(val x: Int, val y: Int, val px: Double, val py: Double)

    fun spot(lat: Double, lon: Double, zoom: Int, size: Int = 256): Spot {
        val n = 2.0.pow(zoom)
        val clamped = lat.coerceIn(-85.05112878, 85.05112878)
        val xf = (lon + 180.0) / 360.0 * n
        val latRad = clamped * PI / 180
        val yf = (1.0 - ln(tan(latRad) + 1 / cos(latRad)) / PI) / 2.0 * n
        val x = floor(xf).toInt().coerceIn(0, n.toInt() - 1)
        val y = floor(yf).toInt().coerceIn(0, n.toInt() - 1)
        return Spot(x, y, (xf - x) * size, (yf - y) * size)
    }

    /** Ground metres per tile pixel at [lat] and [zoom]: how big a circle of metres is on screen. */
    fun metresPerPixel(lat: Double, zoom: Int, size: Int = 256): Double =
        40_075_016.686 * cos(lat * PI / 180) / (size * 2.0.pow(zoom))

    /**
     * The closest zoom, from [closest] outwards, at which a circle of [radius]
     * metres drawn at [scale] is at most [pixels] from its centre to its edge
     * — so a private place fits on the screen that shows it.
     */
    fun zoomToFit(lat: Double, radius: Double, pixels: Double, scale: Double = 1.5, closest: Int = 16, furthest: Int = 3): Int {
        var zoom = closest
        while (zoom > furthest && radius / metresPerPixel(lat, zoom) * scale > pixels) zoom--
        return zoom
    }

    /** The latitude at the top edge of tile row [y] — used by the tests to check [spot]. */
    fun latitudeOfRow(y: Int, zoom: Int): Double {
        val n = PI - 2.0 * PI * y / 2.0.pow(zoom)
        return 180.0 / PI * atan(0.5 * (exp(n) - exp(-n)))
    }
}
