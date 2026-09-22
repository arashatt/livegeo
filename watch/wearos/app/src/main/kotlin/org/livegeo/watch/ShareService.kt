package org.livegeo.watch

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.livegeo.core.Cadence
import org.livegeo.core.Fix
import org.livegeo.core.Words

/**
 * Sharing, while it lasts. A foreground service, so it keeps running with the
 * screen off and the person always has a notification saying it is on, with
 * a Stop button in it.
 *
 * Battery is the real constraint on a watch: continuous GPS lasts hours, not
 * a day. So a fix is asked for once a minute, and only sent when it says
 * something new — moved beyond its own accuracy, or five minutes quiet, which
 * keeps somebody standing still showing as live. See Cadence in core.
 */
class ShareService : Service() {
    private lateinit var fused: FusedLocationProviderClient
    private val scope = CoroutineScope(SupervisorJob())
    private val clock = Handler(Looper.getMainLooper())
    private var last: Fix? = null

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach(::onLocation)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSharing()
            return START_NOT_STICKY
        }
        val session = Store(this).session()
        if (session == null || !session.active(Livegeo.now())) {
            stopSelf()
            return START_NOT_STICKY
        }
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )
        listen()
        // The session ends on time even if no fix arrives to notice it.
        session.remaining(Livegeo.now())?.let { left ->
            clock.removeCallbacksAndMessages(null)
            clock.postDelayed({ stopSharing() }, left * 1000)
        }
        return START_STICKY
    }

    @SuppressLint("MissingPermission") // asked for by the screen before starting this
    private fun listen() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 60_000L)
            .setMinUpdateIntervalMillis(20_000L)
            .build()
        fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
    }

    private fun onLocation(l: Location) {
        val session = Store(this).session() ?: return stopSharing()
        val now = Livegeo.now()
        if (!session.active(now)) return stopSharing()
        val fix = Fix(
            lat = l.latitude,
            lon = l.longitude,
            accuracy = if (l.hasAccuracy()) l.accuracy.toDouble() else null,
            heading = if (l.hasBearing()) l.bearing.toDouble() else null,
            at = l.time / 1000,
            until = session.until,
        )
        if (!Cadence.worthSending(last, fix)) return
        last = fix
        scope.launch { Livegeo.report(this@ShareService, fix) }
        notify(notification())
    }

    private fun stopSharing() {
        clock.removeCallbacksAndMessages(null)
        fused.removeLocationUpdates(callback)
        // One last fix marked stopped keeps the place and ends "live" at once,
        // rather than the map waiting fifteen minutes to notice.
        last?.let { final ->
            scope.launch { Livegeo.report(this@ShareService, final.copy(at = Livegeo.now(), stopped = true, until = null)) }
        }
        Store(this).endSession()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        clock.removeCallbacksAndMessages(null)
        fused.removeLocationUpdates(callback)
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Sharing your location", NotificationManager.IMPORTANCE_LOW),
        )
        val stop = PendingIntent.getService(
            this, 0, Intent(this, ShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val left = Store(this).session()?.remaining(Livegeo.now())
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Sharing your location")
            .setContentText(left?.let { Words.remaining(it) } ?: "until you stop")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }

    private fun notify(n: Notification) =
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)

    companion object {
        const val ACTION_STOP = "org.livegeo.watch.STOP"
        private const val CHANNEL = "sharing"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) = context.startForegroundService(Intent(context, ShareService::class.java))
        fun stop(context: Context) = context.startService(Intent(context, ShareService::class.java).setAction(ACTION_STOP))
    }
}
