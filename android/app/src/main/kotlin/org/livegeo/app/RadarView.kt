package org.livegeo.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.SweepGradient
import android.os.SystemClock
import android.provider.Settings
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * The loading screen's radar: rings, a sweep with a fading trail, and blips
 * in the map's colours that light up as the sweep passes and fade after it.
 * With animations switched off in the system settings it stands still.
 */
class RadarView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private class Blip(val angle: Float, val distance: Float, val color: Int)

    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = v * density

    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
        color = Color.argb(90, 0x4E, 0x6C, 0x77)
    }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.5f)
        color = Color.argb(150, 0xFF, 0xD6, 0x8A)
    }
    private val lead = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
        color = Color.argb(220, 0xFF, 0xD6, 0x8A)
    }
    private val sweep = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val halo = Paint(Paint.ANTI_ALIAS_FLAG)

    // You, somebody live, somebody live, somebody in a private place, an SOS.
    private val blips = listOf(
        Blip(35f, 0.34f, Color.rgb(0x5B, 0xC5, 0xFF)),
        Blip(118f, 0.62f, Color.rgb(0x62, 0xEF, 0xAE)),
        Blip(205f, 0.48f, Color.rgb(0x62, 0xEF, 0xAE)),
        Blip(262f, 0.78f, Color.rgb(0xB2, 0xA1, 0xFF)),
        Blip(318f, 0.56f, Color.rgb(0xFF, 0x6B, 0x78)),
    )

    private var cx = 0f
    private var cy = 0f
    private var radius = 0f
    private var start = 0L

    private val still: Boolean =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    /** Whether it turns. Off while nothing shows it, which costs nothing. */
    var running: Boolean = true
        set(value) {
            field = value
            if (value) postInvalidateOnAnimation()
        }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        cx = w / 2f
        cy = h * 0.44f
        radius = min(w, h) * 0.42f
        val clear = Color.argb(0, 0xFF, 0xD6, 0x8A)
        sweep.shader = SweepGradient(
            cx, cy,
            intArrayOf(clear, clear, Color.argb(20, 0xFF, 0xD6, 0x8A), Color.argb(110, 0xFF, 0xD6, 0x8A)),
            floatArrayOf(0f, 0.66f, 0.7f, 1f),
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (radius <= 0f) return
        val now = SystemClock.uptimeMillis()
        if (start == 0L) start = now
        val angle = if (still) 300f else ((now - start) / 1000f * 110f) % 360f

        for (i in 1..4) canvas.drawCircle(cx, cy, radius * i / 4f, ring)
        canvas.drawLine(cx - radius, cy, cx + radius, cy, ring)
        canvas.drawLine(cx, cy - radius, cx, cy + radius, ring)
        canvas.drawCircle(cx, cy, radius, edge)

        canvas.save()
        canvas.rotate(angle, cx, cy)
        canvas.drawCircle(cx, cy, radius, sweep)
        canvas.restore()
        val rad = Math.toRadians(angle.toDouble())
        canvas.drawLine(cx, cy, cx + radius * cos(rad).toFloat(), cy + radius * sin(rad).toFloat(), lead)

        for (b in blips) {
            val behind = ((angle - b.angle) % 360f + 360f) % 360f
            val light = if (still) 1f else (1f - behind / 260f).coerceIn(0f, 1f)
            if (light <= 0f) continue
            val a = Math.toRadians(b.angle.toDouble())
            val x = cx + radius * b.distance * cos(a).toFloat()
            val y = cy + radius * b.distance * sin(a).toFloat()
            halo.color = b.color
            halo.alpha = (light * 60).toInt()
            canvas.drawCircle(x, y, dp(11f), halo)
            dot.color = b.color
            dot.alpha = (light * 255).toInt()
            canvas.drawCircle(x, y, dp(3.5f), dot)
        }

        if (running && !still && isShown) postInvalidateOnAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility == VISIBLE && running) postInvalidateOnAnimation()
    }
}
