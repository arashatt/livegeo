package org.livegeo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.livegeo.core.Api
import org.livegeo.core.Duration
import org.livegeo.core.HttpTransport
import org.livegeo.core.Links
import org.livegeo.core.Probe
import org.livegeo.core.Reach
import org.livegeo.core.Trouble
import java.io.File
import kotlin.math.max

/**
 * One screen: the map page, full-screen, in a web view, with the app's own
 * screens in front of it while it loads or when it cannot be reached.
 *
 * The page is the same one a browser gets, so everything on the map works
 * here without a second implementation of it. The app adds what a browser
 * cannot do: remember where the map is, share this device's GPS as a live
 * position (ShareService), keep the screen on, feel like a game.
 */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var loading: View
    private lateinit var radar: RadarView
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var tip: TextView
    private lateinit var connect: View
    private lateinit var connectTitle: TextView
    private lateinit var connectBody: TextView
    private lateinit var address: EditText
    private lateinit var telegram: Button
    private lateinit var retry: Button

    private val store by lazy { Store(this) }
    private val ui = Handler(Looper.getMainLooper())

    /** The map is on screen, past the loading screen. */
    private var revealed = false

    /** Why the map is not on screen, when it could not be loaded. */
    private var trouble: Trouble? = null

    private var readySince = 0L
    private var lastBack = 0L
    private var tips: Array<String> = emptyArray()
    private var tipIndex = 0

    /** The origin of the page on screen. Read by the bridge, on another thread. */
    @Volatile private var pageOrigin: String? = null

    /** Pairing is under way: a second tap on Go live waits for it rather than pairing twice. */
    private var goingLive = false

    /** Counts the map being opened, so a late answer about an earlier link is not acted on. */
    private var opening = 0

    private var pendingFile: ByteArray? = null
    private var afterPermission: (() -> Unit)? = null

    private val onSharingChanged: () -> Unit = { pushSharing() }

    private val createDocument = registerForActivityResult(CreateDocument()) { uri -> writePending(uri) }
    private val askPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            val then = afterPermission
            afterPermission = null
            then?.invoke()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        loading = findViewById(R.id.loading)
        radar = findViewById(R.id.radar)
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        tip = findViewById(R.id.tip)
        connect = findViewById(R.id.connect)
        connectTitle = findViewById(R.id.connectTitle)
        connectBody = findViewById(R.id.connectBody)
        address = findViewById(R.id.address)
        telegram = findViewById(R.id.telegram)
        retry = findViewById(R.id.retry)
        tips = resources.getStringArray(R.array.tips)

        // A map you drive by is a map you look at: the screen stays on while
        // it is in front, as a navigation app's or a game's does.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive()
        insets()
        setupWeb()
        setupConnect()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = back()
        })
        Livegeo.onChange = onSharingChanged

        // Recreated after the system reclaimed the app: the link that started
        // it has been used, so go to the map instead of signing in with it again.
        if (savedInstanceState != null || !handleIntent(intent)) start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        immersive()
        pushSharing()
    }

    override fun onPause() {
        web.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        if (Livegeo.onChange === onSharingChanged) Livegeo.onChange = null
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------- the frame

    /** Full screen, bars hidden until swiped in: nothing between you and the map. */
    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).run {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /**
     * The screens run edge to edge, under a notch too, but the map is kept
     * clear of the notch so nothing on it hides behind one, and it shrinks
     * above the keyboard when the page has a field in use.
     */
    private fun insets() {
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            web.updateLayoutParams<FrameLayout.LayoutParams> {
                setMargins(cut.left, cut.top, cut.right, max(cut.bottom, ime.bottom))
            }
            connect.setPadding(cut.left, cut.top, cut.right, max(cut.bottom, ime.bottom))
            insets
        }
    }

    // ------------------------------------------------------------- the page

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun setupWeb() {
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.paper))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Pinching is the map's, not the page's.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // The HUD is laid out for its own sizes; system font scaling would
            // push it into itself.
            textZoom = 100
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            userAgentString = "$userAgentString LivegeoApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(this), "LivegeoApp")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, _, disposition, mime, _ -> download(url, disposition, mime) }
    }

    /** Whether the page asking is the map. Called by the bridge on its own thread. */
    fun trusted(): Boolean {
        val origin = pageOrigin
        return origin != null && origin == store.server
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val server = store.server
            // The map and its own pages stay here. Anything else is not the
            // map, and opens where the device opens links.
            if (server != null && Links.sameOrigin(request.url.toString(), server)) return false
            openOutside(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageOrigin = Links.origin(url)
            // Signing out of the map signs this device's sharing out with it.
            if (Uri.parse(url).path == "/auth/logout" && Livegeo.sharing(this@MainActivity) != null) {
                ShareService.stop(this@MainActivity)
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            CookieManager.getInstance().flush()
            // Back from the map should not land on a sign-in link already used.
            if (Uri.parse(url).path == "/") web.clearHistory()
            if (trouble == null && !revealed) awaitReady()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) failed(Reach.trouble(networkUp(), errorCode = error.errorCode))
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && Reach.isFailure(response.statusCode)) {
                failed(Reach.trouble(networkUp(), status = response.statusCode))
            }
        }

        @RequiresApi(26)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's renderer died (memory, a GPU fault). Start over with
            // a new web view rather than take the app down with the old one.
            ui.removeCallbacksAndMessages(null)
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (revealed || trouble != null) return
            progress.progress = max(progress.progress, newProgress * 7 / 10)
            status.setText(if (newProgress < 35) R.string.status_connecting else R.string.status_city)
        }

        // The page asking where you are ("recentre on me"): the map only, and
        // only once the app itself may know.
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            val server = store.server
            if (server == null || Links.origin(origin) != server) {
                callback.invoke(origin, false, false)
                return
            }
            if (hasLocation()) {
                callback.invoke(origin, true, false)
                return
            }
            askLocation { callback.invoke(origin, hasLocation(), false) }
        }
    }

    // --------------------------------------------------- loading and ready

    private fun start() {
        val server = store.server ?: return showConnect(null)
        val attempt = ++opening
        showLoading()
        web.loadUrl("$server/")
        // Asked beside the load, so a map opens no slower for it: an address
        // remembered before the app checked what it was given (a download
        // page, say) is forgotten the moment it says it is not a map.
        lifecycleScope.launch {
            val answer = probe(server)
            if (attempt != opening || store.server != server) return@launch
            if (answer == Probe.NOT_MAP && networkValidated()) {
                store.server = null
                web.stopLoading()
                web.loadUrl("about:blank")
                notAMap()
            }
        }
    }

    /**
     * A link to the map, from the bot's /login: the map is wherever it says,
     * from now on. But only once the address has said it is a LiveGeo map
     * (Api.probe): any https link can be shared or pasted here, and one that
     * leads somewhere else must not become what the app opens every time.
     */
    private fun open(link: String) {
        val origin = Links.origin(link) ?: return toast(R.string.no_link)
        val attempt = ++opening
        showLoading()
        status.setText(R.string.status_checking)
        // Asked even of the address already kept: an earlier version kept
        // whatever it was given.
        lifecycleScope.launch {
            val answer = probe(origin)
            // Another link was shared, or the map reopened, while this one
            // was being asked about: that one is what the screen is for now.
            if (attempt != opening) return@launch
            when {
                // On a network that is not really online (a hotel's sign-in
                // page), every address answers with that page.
                answer == Probe.NOT_MAP && !networkValidated() -> failed(Trouble.NO_NETWORK)
                answer == Probe.NOT_MAP -> {
                    if (store.server == origin) store.server = null
                    notAMap()
                }
                else -> {
                    // A map, or one that cannot be asked right now: loading it
                    // says which of moved, down or offline it is.
                    store.server = origin
                    web.loadUrl(link)
                }
            }
        }
    }

    private suspend fun probe(origin: String): Probe =
        withContext(Dispatchers.IO) { Api(origin, HttpTransport(PROBE_TIMEOUT_MS)).probe() }

    private fun notAMap() {
        ui.removeCallbacks(pollReady)
        ui.removeCallbacks(nextTip)
        radar.running = false
        Sfx.error(this)
        showConnect(Trouble.NOT_A_MAP)
    }

    private fun handleIntent(intent: Intent?): Boolean {
        val text = when (intent?.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> intent.dataString
            else -> null
        } ?: return false
        val link = Links.find(text)
        if (link == null) {
            toast(R.string.no_link)
            return false
        }
        open(link)
        return true
    }

    private fun showLoading() {
        revealed = false
        trouble = null
        ui.removeCallbacks(pollReady)
        connect.visibility = View.GONE
        loading.animate().cancel()
        loading.alpha = 1f
        loading.visibility = View.VISIBLE
        radar.running = true
        progress.progress = 0
        status.setText(R.string.status_connecting)
        if (tips.isNotEmpty()) {
            tipIndex = (tips.indices).random()
            tip.text = tips[tipIndex]
        }
        ui.removeCallbacks(nextTip)
        ui.postDelayed(nextTip, TIP_MS)
    }

    private val nextTip = object : Runnable {
        override fun run() {
            if (tips.isEmpty() || !loading.isVisible) return
            tip.animate().alpha(0f).setDuration(180).withEndAction {
                tipIndex = (tipIndex + 1) % tips.size
                tip.text = tips[tipIndex]
                tip.animate().alpha(1f).setDuration(260).start()
            }.start()
            ui.postDelayed(this, TIP_MS)
        }
    }

    /**
     * The loading screen stays until the map is drawn, not merely until the
     * page has arrived: the 3D map needs its style and first tiles first.
     * A page that is not the map (signing in, signed out) shows at once.
     */
    private fun awaitReady() {
        readySince = SystemClock.uptimeMillis()
        status.setText(R.string.status_people)
        ui.removeCallbacks(pollReady)
        ui.post(pollReady)
    }

    private val pollReady: Runnable = object : Runnable {
        override fun run() {
            if (revealed || trouble != null || isFinishing) return
            web.evaluateJavascript(PROBE) { raw ->
                val parts = raw.orEmpty().trim('"').split('|', limit = 2)
                val state = parts.getOrElse(0) { "" }
                val bot = parts.getOrElse(1) { "" }
                if (BOT.matches(bot) && bot != store.bot) store.bot = bot
                if (revealed || trouble != null) return@evaluateJavascript
                progress.progress = (progress.progress + 1).coerceAtMost(96)
                when {
                    state == "page" || state == "game" || state == "classic" -> reveal()
                    SystemClock.uptimeMillis() - readySince > READY_LIMIT_MS -> reveal()
                    else -> ui.postDelayed(this, 250)
                }
            }
        }
    }

    private fun reveal() {
        if (revealed) return
        revealed = true
        ui.removeCallbacks(nextTip)
        progress.progress = 100
        status.setText(R.string.status_ready)
        Sfx.ready(this)
        pushSharing()
        loading.animate().alpha(0f).setStartDelay(220).setDuration(420).withEndAction {
            loading.visibility = View.GONE
            loading.alpha = 1f
            radar.running = false
        }.start()
    }

    // --------------------------------------------------------- connecting

    private fun setupConnect() {
        findViewById<Button>(R.id.paste).setOnClickListener {
            Sfx.tick(this)
            pasteLink()
        }
        findViewById<Button>(R.id.go).setOnClickListener {
            Sfx.tick(this)
            typedLink()
        }
        address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                typedLink()
                true
            } else {
                false
            }
        }
        telegram.setOnClickListener {
            Sfx.tick(this)
            store.bot?.let { openOutside(Uri.parse("https://t.me/$it")) }
        }
        retry.setOnClickListener {
            Sfx.tick(this)
            start()
        }
    }

    private fun failed(why: Trouble) {
        if (trouble == why && connect.isVisible) return
        ui.removeCallbacks(pollReady)
        ui.removeCallbacks(nextTip)
        radar.running = false
        Sfx.error(this)
        showConnect(why)
    }

    private fun showConnect(why: Trouble?) {
        trouble = why
        revealed = false
        val (title, body) = when (why) {
            null -> R.string.connect_title to R.string.connect_body
            Trouble.MOVED -> R.string.moved_title to R.string.moved_body
            Trouble.DOWN -> R.string.down_title to R.string.down_body
            Trouble.NO_NETWORK -> R.string.offline_title to R.string.offline_body
            Trouble.NOT_A_MAP -> R.string.not_map_title to R.string.not_map_body
        }
        connectTitle.setText(title)
        connectBody.setText(body)
        retry.isVisible = why != null && store.server != null
        telegram.isVisible = store.bot != null && why != Trouble.NO_NETWORK
        loading.visibility = View.GONE
        connect.alpha = 0f
        connect.visibility = View.VISIBLE
        connect.animate().alpha(1f).setDuration(240).start()
    }

    private fun pasteLink() {
        val clip = getSystemService(ClipboardManager::class.java)?.primaryClip
        val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
        val link = Links.find(text) ?: return toast(R.string.no_link)
        open(link)
    }

    private fun typedLink() {
        val typed = address.text.toString().trim()
        if (typed.isEmpty()) return
        if (typed.startsWith("http://", ignoreCase = true)) return toast(R.string.not_https)
        val link = Links.find(if (typed.contains("://")) typed else "https://$typed") ?: return toast(R.string.no_link)
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(address.windowToken, 0)
        open(link)
    }

    // ------------------------------------------------------------ going live

    /** {"on":…, "until":…, "paired":…}, for the page's Go live button. */
    fun sharingJson(): String {
        val session = Livegeo.sharing(this)
        return JSONObject()
            .put("on", session != null)
            .put("until", session?.until ?: JSONObject.NULL)
            .put("paired", store.token != null)
            .toString()
    }

    private fun pushSharing() {
        if (!revealed) return
        web.evaluateJavascript("window.livegeoApp&&window.livegeoApp.onSharing(${sharingJson()})", null)
    }

    fun toggleSharing() {
        if (Livegeo.sharing(this) != null) confirmStop() else goLive()
    }

    private fun confirmStop() {
        AlertDialog.Builder(this)
            .setTitle(R.string.stop_title)
            .setMessage(R.string.stop_body)
            .setPositiveButton(R.string.stop) { _, _ ->
                ShareService.stop(this)
                Sfx.stop(this)
            }
            .setNegativeButton(R.string.keep, null)
            .show()
    }

    /**
     * Going live: this device joins the map as the person signed in (with the
     * page's own session, no code to type), may know where it is, and is told
     * for how long.
     */
    private fun goLive() {
        if (goingLive) return
        val server = store.server ?: return
        val cookie = CookieManager.getInstance().getCookie(server)
        if (cookie.isNullOrBlank()) return showError(getString(R.string.pair_failed, "sign in to the map first"))
        if (store.token == null) toast(R.string.pairing)
        goingLive = true
        lifecycleScope.launch {
            val paired = Livegeo.ensurePaired(this@MainActivity, cookie)
            goingLive = false
            paired.exceptionOrNull()?.let { e ->
                Sfx.error(this@MainActivity)
                return@launch showError(getString(R.string.pair_failed, e.message ?: e.javaClass.simpleName))
            }
            if (hasLocation()) {
                chooseDuration()
            } else {
                askLocation { if (hasLocation()) chooseDuration() else toast(R.string.needs_location) }
            }
        }
    }

    private fun chooseDuration() {
        val durations = arrayOf(Duration.HOUR, Duration.FOUR_HOURS, Duration.UNTIL_STOPPED)
        val labels = arrayOf(getString(R.string.for_hour), getString(R.string.for_four_hours), getString(R.string.until_stopped))
        AlertDialog.Builder(this)
            .setTitle(R.string.go_live_title)
            .setItems(labels) { _, which ->
                store.startSession(Livegeo.now(), durations[which])
                ShareService.start(this)
                Sfx.live(this)
                pushSharing()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun hasLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun askLocation(then: () -> Unit) {
        afterPermission = then
        val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
        askPermissions.launch(wanted.toTypedArray())
    }

    // ------------------------------------------------------- files, links

    /** A file the page made: saved where the person picks. */
    fun saveFile(name: String, mime: String, base64: String) {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return toast(R.string.save_failed)
        pendingFile = bytes
        createDocument.launch(name to mime.ifBlank { "application/octet-stream" })
    }

    private fun writePending(uri: Uri?) {
        val bytes = pendingFile
        pendingFile = null
        if (uri == null || bytes == null) return
        val written = runCatching { contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null }.getOrDefault(false)
        toast(if (written) R.string.saved else R.string.save_failed)
    }

    /** The share sheet, for what the page would have handed to navigator.share. */
    fun share(json: String) {
        val data = runCatching { JSONObject(json) }.getOrNull() ?: return
        val send = Intent(Intent.ACTION_SEND)
        val files = data.optJSONArray("files")
        if (files != null && files.length() > 0) {
            val first = files.getJSONObject(0)
            val name = first.optString("name").replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80).ifBlank { "livegeo" }
            val dir = File(cacheDir, "shared").apply { mkdirs() }
            val file = File(dir, name)
            val bytes = runCatching { Base64.decode(first.optString("base64"), Base64.DEFAULT) }.getOrNull() ?: return
            if (runCatching { file.writeBytes(bytes) }.isFailure) return
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            send.type = first.optString("type").ifBlank { "application/octet-stream" }
            send.putExtra(Intent.EXTRA_STREAM, uri)
            send.clipData = ClipData.newRawUri(name, uri)
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else {
            send.type = "text/plain"
            val text = listOf(data.optString("text"), data.optString("url")).filter { it.isNotBlank() }.joinToString("\n")
            send.putExtra(Intent.EXTRA_TEXT, text)
        }
        data.optString("title").takeIf { it.isNotBlank() }?.let { send.putExtra(Intent.EXTRA_SUBJECT, it) }
        runCatching { startActivity(Intent.createChooser(send, getString(R.string.share_with))) }
    }

    private fun download(url: String, disposition: String?, mime: String?) {
        val uri = Uri.parse(url)
        // blob: and data: files come through the bridge (saveFile) instead.
        if (uri.scheme != "https") return
        val server = store.server
        if (server == null || !Links.sameOrigin(url, server)) return openOutside(uri)
        try {
            val name = URLUtil.guessFileName(url, disposition, mime)
            val request = DownloadManager.Request(uri)
                .addRequestHeader("cookie", CookieManager.getInstance().getCookie(url).orEmpty())
                .setMimeType(mime)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            getSystemService(DownloadManager::class.java)?.enqueue(request)
            toast(R.string.saved)
        } catch (e: Exception) {
            toast(R.string.save_failed)
        }
    }

    private fun openOutside(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme !in setOf("https", "http", "tg", "mailto", "geo")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
    }

    // ------------------------------------------------------------- the rest

    private fun back() {
        if (loading.isVisible || connect.isVisible) return leaveOrWarn()
        // A dialog or a panel open on the map closes first, as a game's menu would.
        web.evaluateJavascript(CLOSE_SOMETHING) { closed ->
            when {
                closed == "true" -> Unit
                web.canGoBack() -> web.goBack()
                else -> leaveOrWarn()
            }
        }
    }

    private fun leaveOrWarn() {
        val now = SystemClock.uptimeMillis()
        if (now - lastBack < 2000) {
            finish()
        } else {
            lastBack = now
            toast(R.string.back_again)
        }
    }

    private fun networkUp(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Online for real, as Android judged it: not behind a network's sign-in page. */
    private fun networkValidated(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun toast(message: Int) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun showError(message: String) {
        AlertDialog.Builder(this).setMessage(message).setPositiveButton(android.R.string.ok, null).show()
    }

    /** ACTION_CREATE_DOCUMENT with the name and type decided when saving, not up front. */
    private class CreateDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
    }

    companion object {
        private const val TIP_MS = 3600L
        private const val PROBE_TIMEOUT_MS = 8_000
        private const val READY_LIMIT_MS = 25_000L
        private val BOT = Regex("[A-Za-z][A-Za-z0-9_]{3,31}")

        /**
         * What is on screen, and the bot's name when the page carries it:
         * "signing" while a sign-in link's page sends itself on (so the
         * loading screen stays up through it to the map), "page" for anything
         * else that is not the map, "game" once the 3D map has its style,
         * "classic" for the 2D one, "loading" until then.
         */
        private const val PROBE = """(function(){var b=document.body;if(!b)return 'loading|';var bot=(b.dataset&&b.dataset.bot)||'';if(document.querySelector('form[method=post][action^="/auth/"]'))return 'signing|'+bot;if(!document.getElementById('map'))return 'page|'+bot;var r=b.dataset.renderer||'';if(r==='game'){var m=window.livegeoMap;return((m&&m.gl&&m.gl.isStyleLoaded&&m.gl.isStyleLoaded())?'game':'loading')+'|'+bot;}return(r==='classic'?'classic':'loading')+'|'+bot;})()"""

        /** The topmost dialog, or an open panel on the map toolbar, closed; "true" if there was one. */
        private const val CLOSE_SOMETHING = """(function(){var d=document.querySelectorAll('dialog[open]');if(d.length){d[d.length-1].close();return true;}var b=document.querySelector('.map-toolbar [aria-expanded="true"]');if(b){b.click();return true;}return false;})()"""
    }
}
