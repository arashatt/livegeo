package org.livegeo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.livegeo.core.Cadence
import org.livegeo.core.Failure
import org.livegeo.core.Fix
import org.livegeo.core.Words
import kotlin.math.abs

/**
 * Sharing, while it lasts. A foreground service, so it keeps going with the
 * screen off or another app in front, and the person always has a
 * notification saying it is on, with a Stop button.
 *
 * Android's own location providers, not Google Play services: car head units
 * and phones sold without Google have none. GPS is asked every 5 seconds;
 * the network provider fills in only while GPS is silent. A fix is sent when
 * it says something new (Cadence in core): moved further than its own
 * accuracy, never less than 25 m, or two minutes without one, which keeps
 * somebody parked showing as live.
 */
class ShareService : Service(), LocationListener {
    private lateinit var locations: LocationManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val clock = Handler(Looper.getMainLooper())
    private var last: Fix? = null
    private var gpsHeardAt = 0L
    private var listening = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        locations = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSharing()
            return START_NOT_STICKY
        }
        // Foreground before anything else: a service started as a foreground
        // one that stops without saying so takes the app down with it.
        if (!startForegroundNow()) {
            stopSharing(sendLast = false)
            return START_NOT_STICKY
        }
        val session = Livegeo.sharing(this)
        if (session == null || !hasLocationPermission()) {
            stopSharing(sendLast = false)
            return START_NOT_STICKY
        }
        listen()
        // The session ends on time even if no fix arrives to notice it.
        clock.removeCallbacksAndMessages(null)
        session.remaining(Livegeo.now())?.let { left -> clock.postDelayed({ stopSharing() }, left * 1000) }
        Livegeo.changed()
        return START_STICKY
    }

    private fun startForegroundNow(): Boolean = try {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
        )
        true
    } catch (e: Exception) {
        // Not allowed from the background, or the location permission was
        // taken away since sharing started.
        false
    }

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // checked in onStartCommand before this
    private fun listen() {
        if (listening) return
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in locations.allProviders }
        for (provider in providers) {
            runCatching { locations.requestLocationUpdates(provider, 5_000L, 0f, this, Looper.getMainLooper()) }
        }
        listening = true
        // A recent fix the device already has puts you on the map at once,
        // instead of after the first new one.
        providers
            .mapNotNull { runCatching { locations.getLastKnownLocation(it) }.getOrNull() }
            .filter { abs(System.currentTimeMillis() - it.time) < 120_000 }
            .maxByOrNull { it.time }
            ?.let(::onLocationChanged)
    }

    override fun onLocationChanged(location: Location) {
        val session = Livegeo.sharing(this) ?: return stopSharing()
        val heard = SystemClock.elapsedRealtime()
        if (location.provider == LocationManager.GPS_PROVIDER) {
            gpsHeardAt = heard
        } else if (gpsHeardAt != 0L && heard - gpsHeardAt < 30_000) {
            return // GPS is talking; the network's guess adds nothing
        }
        val moving = location.hasSpeed() && location.speed > 1f
        // A head unit's clock can be hours out until it syncs; a fix is
        // stamped with the phone's time then, not refused by the server.
        val nowMs = System.currentTimeMillis()
        val takenMs = if (abs(location.time - nowMs) > 10 * 60_000) nowMs else location.time
        val fix = Fix(
            lat = location.latitude,
            lon = location.longitude,
            accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
            // A bearing at walking pace or standing still points anywhere.
            heading = if (location.hasBearing() && moving) location.bearing.toDouble() else null,
            at = takenMs / 1000,
            until = session.until,
        )
        if (!Cadence.worthSending(last, fix, minMetres = 25.0, heartbeatSeconds = 120)) return
        last = fix
        scope.launch {
            val sent = Livegeo.report(this@ShareService, fix)
            if (sent.exceptionOrNull() is Failure.Unpaired) stopSharing(sendLast = false) else notify(notification())
        }
    }

    // Called by Android 10 and older, where these have no default: without
    // them, a GPS switched on or off in the settings is a crash there.
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    private fun stopSharing(sendLast: Boolean = true) {
        clock.removeCallbacksAndMessages(null)
        if (listening) {
            runCatching { locations.removeUpdates(this) }
            listening = false
        }
        // One last fix marked stopped keeps the place and ends "live" at once,
        // rather than the map waiting fifteen minutes to notice. Sent from a
        // scope that outlives this service, which is about to be gone.
        val lastFix = last
        if (sendLast && lastFix != null) {
            val app = applicationContext
            Livegeo.background.launch { Livegeo.report(app, lastFix.copy(at = Livegeo.now(), stopped = true, until = null)) }
        }
        last = null
        Store(this).endSession()
        Livegeo.changed()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        clock.removeCallbacksAndMessages(null)
        if (listening) runCatching { locations.removeUpdates(this) }
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(): Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.sharing_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val stop = PendingIntent.getService(
            this, 0, Intent(this, ShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val left = Livegeo.sharing(this)?.remaining(Livegeo.now())
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_live)
            .setColor(ContextCompat.getColor(this, R.color.accent))
            .setContentTitle(getString(R.string.sharing_title))
            .setContentText(left?.let { Words.remaining(it) } ?: getString(R.string.sharing_until_stopped))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.stop), stop)
            .build()
    }

    private fun notify(n: Notification) =
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)

    companion object {
        const val ACTION_STOP = "org.livegeo.app.STOP"
        private const val CHANNEL = "sharing"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) =
            ContextCompat.startForegroundService(context, Intent(context, ShareService::class.java))

        fun stop(context: Context) {
            context.startService(Intent(context, ShareService::class.java).setAction(ACTION_STOP))
        }
    }
}
