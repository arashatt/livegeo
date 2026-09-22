package org.livegeo.watch

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.livegeo.core.Tiles
import java.net.HttpURLConnection
import java.net.URL

/**
 * A small map around one point, drawn from the server's own /tiles proxy.
 * Not Google Maps: that needs an API key and sends every look to Google, and
 * the server already has the tiles, cached, behind the same token.
 */
@Composable
fun TileMap(lat: Double, lon: Double, zoom: Int = 15, area: Double? = null) {
    val context = LocalContext.current
    val spot = remember(lat, lon, zoom) { Tiles.spot(lat, lon, zoom) }
    var tiles by remember { mutableStateOf<Map<Pair<Int, Int>, ImageBitmap>>(emptyMap()) }

    LaunchedEffect(spot.x, spot.y, zoom) {
        val api = Livegeo.api(context)
        val got = mutableMapOf<Pair<Int, Int>, ImageBitmap>()
        withContext(Dispatchers.IO) {
            val span = 1 shl zoom
            for (dx in -1..1) for (dy in -1..1) {
                val x = Math.floorMod(spot.x + dx, span)
                val y = spot.y + dy
                if (y < 0 || y >= span) continue
                runCatching {
                    val c = URL(api.tileUrl(zoom, x, y)).openConnection() as HttpURLConnection
                    api.authHeader().forEach { (k, v) -> c.setRequestProperty(k, v) }
                    c.connectTimeout = 15_000
                    c.readTimeout = 15_000
                    val bytes = c.inputStream.use { it.readBytes() }
                    c.disconnect()
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }.getOrNull()?.let { got[(spot.x + dx) to y] = it }
            }
        }
        tiles = got
    }

    Canvas(Modifier.fillMaxSize()) {
        // Tiles are 256 px; drawn a little larger so a street is legible on
        // a watch's dense screen.
        val tile = (256 * 1.5f).toInt()
        val scale = tile / 256f
        val cx = size.width / 2
        val cy = size.height / 2
        for ((key, image) in tiles) {
            val left = cx - spot.px.toFloat() * scale + (key.first - spot.x) * tile
            val top = cy - spot.py.toFloat() * scale + (key.second - spot.y) * tile
            drawImage(
                image = image,
                srcOffset = IntOffset.Zero,
                srcSize = IntSize(image.width, image.height),
                dstOffset = IntOffset(left.toInt(), top.toInt()),
                dstSize = IntSize(tile, tile),
            )
        }
        if (area != null) {
            // Somewhere inside a private place: the place, drawn as the soft
            // area the dashboard shows, and no dot, because there is no point.
            val r = (area / Tiles.metresPerPixel(lat, zoom) * scale).toFloat()
            drawCircle(Color(0x400A7D33), radius = r, center = Offset(cx, cy))
            drawCircle(Color(0xA00A7D33), radius = r, center = Offset(cx, cy), style = Stroke(2.dp.toPx()))
        } else {
            // The person: the same green dot as on the dashboard.
            drawCircle(Color.White, radius = 9.dp.toPx(), center = Offset(cx, cy))
            drawCircle(Color(0xFF0A7D33), radius = 9.dp.toPx(), center = Offset(cx, cy), style = Stroke(3.dp.toPx()))
        }
    }
}
