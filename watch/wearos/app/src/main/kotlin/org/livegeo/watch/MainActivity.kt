package org.livegeo.watch

import android.Manifest
import android.content.pm.PackageManager
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.livegeo.core.Duration
import org.livegeo.core.Failure
import org.livegeo.core.Geo
import org.livegeo.core.Person
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
    var looking by remember { mutableStateOf<Person?>(null) }

    Scaffold(timeText = { TimeText() }) {
        val person = looking
        when {
            !paired -> PairScreen(onPaired = { paired = true })
            person != null -> {
                BackHandler { looking = null }
                PersonScreen(person)
            }
            else -> HomeScreen(onOpen = { looking = it }, onUnpaired = { paired = false })
        }
    }
}

// ------------------------------------------------------------------ pairing

@Composable
fun PairScreen(onPaired: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var digits by remember { mutableStateOf("") }
    // A build made without LIVEGEO_SERVER points at the placeholder, and
    // pairing could only ever fail. Better to say so than to let it.
    val unbuilt = BuildConfig.SERVER.contains("example.")
    var message by remember { mutableStateOf(if (unbuilt) "No server in this build" else "Send /pair to the bot") }
    var busy by remember { mutableStateOf(false) }

    fun submit() {
        busy = true
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                Livegeo.api(context).pair(digits, "${Build.MANUFACTURER} ${Build.MODEL}", "wearos")
            }
            busy = false
            result.onSuccess {
                Store(context).apply { token = it.token; ownerId = it.ownerId; ownerName = it.ownerName }
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
                        enabled = !unbuilt && !busy && (key != "✓" || digits.length == 6),
                        modifier = Modifier.size(ButtonDefaults.ExtraSmallButtonSize),
                        colors = if (key == "✓") ButtonDefaults.primaryButtonColors() else ButtonDefaults.secondaryButtonColors(),
                    ) { Text(key) }
                }
            }
        }
    }
}

// --------------------------------------------------------------------- home

@Composable
fun HomeScreen(onOpen: (Person) -> Unit, onUnpaired: () -> Unit) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var status by remember { mutableStateOf("") }
    var session by remember { mutableStateOf(store.session()) }
    var now by remember { mutableStateOf(Livegeo.now()) }
    var pending by remember { mutableStateOf<Duration?>(null) }

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
            result.onSuccess { people = it; status = "" }
                .onFailure {
                    if (it is Failure.Unpaired) { Livegeo.forget(context); onUnpaired(); return@LaunchedEffect }
                    status = if (it is Failure.Offline) "Offline — will retry" else (it.message ?: "")
                }
            delay(30_000)
        }
    }

    val me = people.firstOrNull { it.id == store.ownerId }
    val others = people.filter { it.id != store.ownerId }

    ScalingLazyColumn(modifier = Modifier.fillMaxSize()) {
        item { ListHeader { Text(store.ownerName?.takeIf { it.isNotBlank() } ?: "livegeo") } }

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
