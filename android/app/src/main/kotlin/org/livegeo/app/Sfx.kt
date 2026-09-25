package org.livegeo.app

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * What the app feels like: a short buzz for a key pressed, a pattern for
 * going live and for stopping, a long one for somebody's SOS. Tones only for
 * going live and stopping, on the notification stream, so a phone on silent
 * stays silent.
 */
object Sfx {
    fun tick(context: Context) = buzz(context, longArrayOf(0, 12))
    fun ready(context: Context) = buzz(context, longArrayOf(0, 18, 70, 28))
    fun error(context: Context) = buzz(context, longArrayOf(0, 40, 50, 40))
    fun sos(context: Context) = buzz(context, longArrayOf(0, 400, 150, 400, 150, 400))

    fun live(context: Context) {
        buzz(context, longArrayOf(0, 30, 60, 30, 60, 70))
        tone(ToneGenerator.TONE_PROP_ACK)
    }

    fun stop(context: Context) {
        buzz(context, longArrayOf(0, 80))
        tone(ToneGenerator.TONE_PROP_NACK)
    }

    /** For the page, which names what happened rather than how it should feel. */
    fun play(context: Context, kind: String) = when (kind) {
        "sos" -> sos(context)
        "live" -> live(context)
        "stop" -> stop(context)
        "error" -> error(context)
        else -> tick(context)
    }

    private fun buzz(context: Context, pattern: LongArray) {
        val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            context.getSystemService(Vibrator::class.java)
        }
        if (vibrator == null || !vibrator.hasVibrator()) return
        runCatching {
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        }
    }

    private fun tone(kind: Int) {
        runCatching {
            val generator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 40)
            generator.startTone(kind, 160)
            Handler(Looper.getMainLooper()).postDelayed({ generator.release() }, 500)
        }
    }
}
