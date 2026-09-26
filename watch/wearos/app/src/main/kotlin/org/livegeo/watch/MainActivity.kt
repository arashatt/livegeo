package org.livegeo.watch

import android.Manifest
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.livegeo.core.Api
import org.livegeo.core.Duration
import org.livegeo.core.Failure
import org.livegeo.core.Geo
import org.livegeo.core.HttpTransport
import org.livegeo.core.Links
import org.livegeo.core.Person
import org.livegeo.core.Probe
import org.livegeo.core.Reach
import org.livegeo.core.Tiles
import org.livegeo.core.Words

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { WatchApp() } }
    }
}

@Composable
fun WatchApp() {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var paired by remember { mutableStateOf(store.token != null) }
    // Finding the map again after its address changed: still paired, and
    // still sharing if it was, while it pairs again.
    var moving by remember { mutableStateOf(false) }
    var looking by remember { mutableStateOf<Person?>(null) }

    Scaffold(timeText = { TimeText() }) {
        val person = looking
        when {
            !paired || moving -> PairScreen(
                moving = moving,
                onPaired = { paired = true; moving = false },
                onCancel = if (moving) ({ moving = false }) else null,
            )
            person != null -> {
                BackHandler { looking = null }
                PersonScreen(person)
            }
            else -> HomeScreen(onOpen = { looking = it }, onUnpaired = { paired = false }, onMove = { moving = true })
        }
    }
}

// ------------------------------------------------------------------ pairing

/**
 * Pairing, in two steps: which map, then the code. Behind a quick tunnel the
 * map's address changes every time the tunnel restarts, so it cannot be built
 * into the app: /pair, and the map's Pair a watch, give the map's name with
 * the code. A build with a map built in, and pairing again with the map it
 * had, start at the code. After the map moved ([moving]) it is asked for
 * again, and pairing again replaces this watch's old entry on the map, so its
 * old token stops working (Api.pair's install).
 */
@Composable
fun PairScreen(moving: Boolean, onPaired: () -> Unit, onCancel: (() -> Unit)?) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var server by remember { mutableStateOf(if (moving) null else store.server) }
    val found = server
    // Back from the code goes to the map's name, to put a wrong one right;
    // back from there, after a move, is back to the watch's own screen.
    if (found != null) {
        BackHandler { server = null }
        CodeStep(found, store, onPaired)
    } else {
        if (onCancel != null) BackHandler(onBack = onCancel)
        MapStep(moving, onFound = { server = it })
    }
}

@Composable
private fun MapStep(moving: Boolean, onFound: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var message by remember {
        mutableStateOf(
            if (moving) "Your map moved. Send /pair to the bot for its new name."
            else "Send /pair to the bot. It gives your map's name and a code.",
        )
    }
    var busy by remember { mutableStateOf(false) }

    // Asked before anything is kept: a name typed wrong, or somebody else's
    // website, is not a map (Api.probe).
    fun look(typed: String) {
        val origin = Links.mapAddress(typed)
        if (origin == null) {
            message = "That is not a map's name. Type it as /pair gave it."
            return
        }
        val name = Links.mapName(origin)
        busy = true
        message = "Looking for $name…"
        scope.launch {
            val answer = withContext(Dispatchers.IO) { Api(origin, HttpTransport(PROBE_MS)).probe() }
            busy = false
            when (answer) {
                Probe.MAP -> onFound(origin)
                Probe.NOT_MAP -> message = "$name is not a livegeo map."
                Probe.UNREACHABLE -> message = "Cannot reach $name. Check the name, and that the watch is online."
            }
        }
    }

    val keyboard = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val typed = result.data?.let { RemoteInput.getResultsFromIntent(it) }?.getCharSequence(MAP_INPUT)?.toString()
        if (!typed.isNullOrBlank()) look(typed)
    }

    ScalingLazyColumn(modifier = Modifier.fillMaxSize()) {
        item { ListHeader { Text(if (moving) "Find your map" else "Which map?") } }
        item { Text(message, textAlign = TextAlign.Center, style = MaterialTheme.typography.body2) }
        item {
            Chip(
                onClick = {
                    try {
                        keyboard.launch(mapInput())
                    } catch (e: ActivityNotFoundException) {
                        message = "This watch has no keyboard for apps to use."
                    }
                },
                label = { Text("Enter its name") },
                enabled = !busy,
                colors = ChipDefaults.primaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun CodeStep(server: String, store: Store, onPaired: () -> Unit) {
    val scope = rememberCoroutineScope()
    var digits by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("Code from /pair") }
    var busy by remember { mutableStateOf(false) }

    fun submit() {
        busy = true
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                Api(server, HttpTransport()).pair(digits, "${Build.MANUFACTURER} ${Build.MODEL}", "wearos", store.install)
            }
            busy = false
            result.onSuccess {
                store.paired(server, it.token, it.ownerId, it.ownerName)
                onPaired()
            }.onFailure {
                digits = ""
                message = when (it) {
                    is Failure.BadCode -> "Wrong or expired code"
                    is Failure.Limited -> "Too many tries — wait"
                    is Failure.Offline -> "No connection"
                    else -> it.message ?: "Could not pair"
                }
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(top = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            if (digits.isEmpty()) message else Words.code(digits),
            style = MaterialTheme.typography.title3,
            textAlign = TextAlign.Center,
        )
        // A keypad rather than the system keyboard: six digits, typed with a
        // fingertip on a screen the size of a coin.
        val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("⌫", "0", "✓"))
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                for (key in row) {
                    Button(
                        onClick = {
                            when (key) {
                                "⌫" -> digits = digits.dropLast(1)
                                "✓" -> if (digits.length == 6 && !busy) submit()
                                else -> if (digits.length < 6) digits += key
                            }
                        },
                        enabled = !busy && (key != "✓" || digits.length == 6),
                        modifier = Modifier.size(ButtonDefaults.ExtraSmallButtonSize),
                        colors = if (key == "✓") ButtonDefaults.primaryButtonColors() else ButtonDefaults.secondaryButtonColors(),
                    ) { Text(key) }
                }
            }
        }
    }
}

private const val MAP_INPUT = "map"
private const val PROBE_MS = 10_000

/** The watch's own text input, whichever it has: keyboard, voice or handwriting. */
private fun mapInput(): Intent = RemoteInputIntentHelper.createActionRemoteInputIntent().also {
    RemoteInputIntentHelper.putRemoteInputsExtra(it, listOf(RemoteInput.Builder(MAP_INPUT).setLabel("Map name").build()))
}

/** Whether the watch has a connection at all. Offline, a failure says nothing about the map. */
private fun online(context: Context): Boolean {
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
    val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}

// --------------------------------------------------------------------- home

@Composable
fun HomeScreen(onOpen: (Person) -> Unit, onUnpaired: () -> Unit, onMove: () -> Unit) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var status by remember { mutableStateOf("") }
    var session by remember { mutableStateOf(store.session()) }
    var now by remember { mutableStateOf(Livegeo.now()) }
    var pending by remember { mutableStateOf<Duration?>(null) }
    // The map's address changed (a quick tunnel restarted): the watch cannot
    // follow on its own, so it says so and offers to find the map again.
    var moved by remember { mutableStateOf(false) }

    // Asked for when sharing starts: "while in use" location is enough,
    // because sharing always starts here, in the foreground.
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val d = pending
        pending = null
        if (d != null && granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            store.startSession(Livegeo.now(), d)
            session = store.session()
            ShareService.start(context)
        } else if (d != null) {
            status = "Location is needed to share"
        }
    }

    fun share(d: Duration) {
        val needed = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            store.startSession(Livegeo.now(), d)
            session = store.session()
            ShareService.start(context)
        } else {
            pending = d
            permissions.launch(missing.toTypedArray())
        }
    }

    // Asked while the screen is on, and not otherwise: a list nobody is
    // looking at is not worth the radio time.
    LaunchedEffect(Unit) {
        while (true) {
            now = Livegeo.now()
            session = store.session()?.takeIf { it.active(now) }
            val result = withContext(Dispatchers.IO) {
                Livegeo.send(context)          // anything the service could not send
                Livegeo.api(context).people()
            }
            result.onSuccess { people = it; status = ""; moved = false }
                .onFailure {
                    if (it is Failure.Unpaired) { Livegeo.forget(context); onUnpaired(); return@LaunchedEffect }
                    moved = Reach.moved(it, online(context))
                    status = when {
                        moved -> ""
                        it is Failure.Offline -> "Offline — will retry"
                        else -> it.message ?: ""
                    }
                }
            delay(30_000)
        }
    }

    val me = people.firstOrNull { it.id == store.ownerId }
    val others = people.filter { it.id != store.ownerId }

    ScalingLazyColumn(modifier = Modifier.fillMaxSize()) {
        item { ListHeader { Text(store.ownerName?.takeIf { it.isNotBlank() } ?: "livegeo") } }

        if (moved) {
            item {
                Chip(
                    onClick = onMove,
                    label = { Text("Your map moved") },
                    secondaryLabel = { Text("Send /pair, then tap here") },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        val s = session
        if (s != null && s.active(now)) {
            item {
                Chip(
                    onClick = { ShareService.stop(context); session = null },
                    label = { Text("Stop sharing") },
                    secondaryLabel = { Text(s.remaining(now)?.let { Words.remaining(it) } ?: "Until you stop") },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        } else {
            item { ShareChip("Share for 1 hour") { share(Duration.HOUR) } }
            item { ShareChip("Share for 4 hours") { share(Duration.FOUR_HOURS) } }
            item { ShareChip("Share until I stop") { share(Duration.UNTIL_STOPPED) } }
        }

        if (status.isNotBlank()) item { Text(status, textAlign = TextAlign.Center) }

        if (others.isEmpty()) {
            item { Text("Nobody else yet. /invite in the bot adds people.", textAlign = TextAlign.Center) }
        }
        items(others) { p ->
            // Somebody inside a private place is not at a point, so there is no
            // distance to give; saying where they are not would be a guess.
            val away = if (p.hidden) {
                "somewhere private · "
            } else if (me?.lat != null && me.lon != null && p.lat != null && p.lon != null) {
                Words.distance(Geo.metres(me.lat!!, me.lon!!, p.lat!!, p.lon!!)) + " · "
            } else ""
            Chip(
                onClick = { onOpen(p) },
                label = { Text(p.name.ifBlank { p.id }) },
                secondaryLabel = { Text(away + Words.ago(now - p.at) + if (p.live) "" else " · not live") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Which map this is, and a way to another: the words /pair gave.
        item {
            Chip(
                onClick = onMove,
                label = { Text("Change map") },
                secondaryLabel = { Text(store.server?.let { Links.mapName(it) } ?: "") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ShareChip(label: String, onClick: () -> Unit) = Chip(
    onClick = onClick,
    label = { Text(label) },
    colors = ChipDefaults.secondaryChipColors(),
    modifier = Modifier.fillMaxWidth(),
)

// ------------------------------------------------------------------- person

@Composable
fun PersonScreen(person: Person) {
    Box(Modifier.fillMaxSize()) {
        if (person.lat != null && person.lon != null) {
            // Inside a private place: the area they are somewhere in, zoomed
            // out until it fits, rather than a pin on its middle.
            val area = if (person.hidden) person.accuracy else null
            val zoom = if (area != null) Tiles.zoomToFit(person.lat!!, area, pixels = 150.0) else 15
            TileMap(person.lat!!, person.lon!!, zoom = zoom, area = area)
        }
        Text(
            person.name.ifBlank { person.id } + "\n" + (if (person.hidden) "somewhere private · " else "") +
                Words.ago(Livegeo.now() - person.at),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 18.dp),
            textAlign = TextAlign.Center,
        )
    }
}
