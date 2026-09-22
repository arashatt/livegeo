package org.livegeo.core

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WireTest {
    @Test fun `fixes are written the way the server reads them`() {
        val json = JSONObject(Wire.fixes(listOf(Fix(36.297, 59.606, accuracy = 6.0, at = 1_790_000_000, until = 1_790_003_600))))
        val f = json.getJSONArray("fixes").getJSONObject(0)
        assertEquals(36.297, f.getDouble("lat"))
        assertEquals(59.606, f.getDouble("lon"))
        assertEquals(1_790_000_000, f.getLong("at"))
        assertEquals(1_790_003_600, f.getLong("until"))
        assertFalse(f.has("heading"), "absent values are left out, not sent as null")
        assertFalse(f.has("stopped"), "only a stop says so")
    }

    @Test fun `a stop says so`() {
        val f = JSONObject(Wire.fixes(listOf(Fix(1.0, 1.0, at = 1, stopped = true)))).getJSONArray("fixes").getJSONObject(0)
        assertTrue(f.getBoolean("stopped"))
    }

    @Test fun `people are read, including someone with no position yet`() {
        val people = Wire.people(
            """{"people":[{"id":42,"name":"Ada","latitude":36.3,"longitude":59.6,"accuracy":8,"at":100,"live":true},
                           {"id":"7","name":"","latitude":null,"longitude":null,"at":90,"live":false}]}""",
        )
        assertEquals("42", people[0].id, "a numeric id is still an id")
        assertEquals(36.3, people[0].lat)
        assertTrue(people[0].live)
        assertNull(people[1].lat)
        assertNull(people[1].accuracy)
    }

    @Test fun `a pairing answer gives the token and whose watch it is`() {
        val p = Wire.paired("""{"token":"t0k","id":3,"owner":{"id":"42","name":"Ada"}}""")
        assertEquals(Paired("t0k", 3, "42", "Ada"), p)
    }

    @Test fun `refusals come back by index`() {
        val r = Wire.ingest("""{"accepted":1,"rejected":[{"index":1,"error":"too old"}]}""")
        assertEquals(1, r.accepted)
        assertEquals(Rejection(1, "too old"), r.rejected.single())
    }
}

class ApiTest {
    private class Recorder(private val answer: (String, String) -> HttpResponse) : Transport {
        val calls = mutableListOf<Triple<String, String, Map<String, String>>>()
        override fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse {
            calls += Triple(method, url, headers)
            return answer(method, url)
        }
    }

    @Test fun `pairing keeps the token and uses it from then on`() {
        val t = Recorder { _, url ->
            if (url.endsWith("/pair")) HttpResponse(200, """{"token":"abc","id":1,"owner":{"id":"42","name":"Ada"}}""")
            else HttpResponse(200, """{"people":[]}""")
        }
        val api = Api("https://map.test/", t)
        assertEquals("42", api.pair("482913", "Watch", "wearos").getOrThrow().ownerId)
        assertNull(t.calls[0].third["authorization"], "pairing is how it gets a token; it has none to send")
        api.people().getOrThrow()
        assertEquals("Bearer abc", t.calls[1].third["authorization"])
        assertEquals("https://map.test/api/positions", t.calls[1].second, "a trailing slash on the base is not doubled")
    }

    @Test fun `each failure is one the screens can act on`() {
        fun failing(status: Int, body: String = "{}") = Api("https://m", Recorder { _, _ -> HttpResponse(status, body) }, "t")
        assertIs<Failure.Unpaired>(failing(401).people().exceptionOrNull())
        assertIs<Failure.Limited>(failing(429, """{"error":"too many wrong codes"}""").pair("1", "", "").exceptionOrNull())
        val bad = failing(404, """{"error":"that code is wrong or has expired"}""").pair("1", "", "").exceptionOrNull()
        assertIs<Failure.BadCode>(bad)
        assertEquals("that code is wrong or has expired", bad.message)
        val offline = Api("https://m", { _, _, _, _ -> throw java.net.ConnectException("no route") }).report(emptyList()).exceptionOrNull()
        assertIs<Failure.Offline>(offline)
    }
}

class OutboxTest {
    private fun fix(at: Long, lat: Double = 1.0) = Fix(lat, 1.0, accuracy = 5.0, at = at)

    @Test fun `nothing is lost while offline, and it all goes when the signal returns`() {
        val box = Outbox()
        (1L..3L).forEach { box.add(fix(1000 + it)) }
        val sent = mutableListOf<Fix>()
        assertTrue(box.drain(now = 1010) { Result.failure<Unit>(Failure.Offline(Exception("tunnel"))) }.isFailure)
        assertEquals(3, box.size, "a failed send keeps everything")
        assertEquals(3, box.drain(now = 1010) { sent += it; Result.success(Unit) }.getOrThrow())
        assertEquals(listOf(1001L, 1002L, 1003L), sent.map { it.at }, "oldest first, with the times they were taken")
        assertEquals(0, box.size)
    }

    @Test fun `sent in batches, and a failure part-way keeps the rest`() {
        val box = Outbox(batch = 2)
        (1L..5L).forEach { box.add(fix(it)) }
        var calls = 0
        val r = box.drain(now = 10) { calls += 1; if (calls == 2) Result.failure<Unit>(Exception("dropped")) else Result.success(Unit) }
        assertTrue(r.isFailure)
        assertEquals(3, box.size, "the first batch went; the second and third wait")
    }

    @Test fun `older than a day is dropped, since the server would refuse it`() {
        val box = Outbox()
        box.add(fix(at = 0))
        box.add(fix(at = 100_000))
        val sent = mutableListOf<Fix>()
        box.drain(now = 100_010) { sent += it; Result.success(Unit) }
        assertEquals(listOf(100_000L), sent.map { it.at })
    }

    @Test fun `when full the oldest goes`() {
        val box = Outbox(capacity = 3)
        (1L..5L).forEach { box.add(fix(it)) }
        val sent = mutableListOf<Fix>()
        box.drain(now = 10) { sent += it; Result.success(Unit) }
        assertEquals(listOf(3L, 4L, 5L), sent.map { it.at })
    }

    @Test fun `it survives the app being killed`() {
        val shelf = MemoryShelf()
        Outbox(shelf).apply { add(Fix(36.5, 59.1, accuracy = null, heading = 90.0, at = 7, until = 99, stopped = true)) }
        val back = mutableListOf<Fix>()
        Outbox(shelf).drain(now = 10) { back += it; Result.success(Unit) }
        assertEquals(Fix(36.5, 59.1, accuracy = null, heading = 90.0, at = 7, until = 99, stopped = true), back.single())
    }

    @Test fun `a damaged line on the shelf is skipped, not fatal`() {
        val shelf = MemoryShelf().apply { text = "garbage\n1.0,2.0,,,5,,0" }
        assertEquals(1, Outbox(shelf).size)
    }
}

class SharingTest {
    @Test fun `a session ends when it says, or never`() {
        val hour = Session(startedAt = 1000, duration = Duration.HOUR)
        assertTrue(hour.active(4599))
        assertFalse(hour.active(4600))
        assertEquals(600, hour.remaining(4000))
        val open = Session(1000, Duration.UNTIL_STOPPED)
        assertTrue(open.active(10_000_000))
        assertNull(open.until)
    }

    @Test fun `a fix is sent only when it says something new`() {
        val here = Fix(36.3, 59.6, accuracy = 10.0, at = 0)
        assertTrue(Cadence.worthSending(null, here), "the first always goes")
        // About 11 m north: inside the 25 m floor.
        assertFalse(Cadence.worthSending(here, here.copy(lat = 36.3001, at = 30)))
        // About 110 m: travel.
        assertTrue(Cadence.worthSending(here, here.copy(lat = 36.301, at = 30)))
        // A poor fix raises the bar for itself, as on the server.
        assertFalse(Cadence.worthSending(here, here.copy(lat = 36.301, accuracy = 200.0, at = 30)))
        // Standing still still goes out now and then, or the wearer expires off the map.
        assertTrue(Cadence.worthSending(here, here.copy(at = 300)))
        assertTrue(Cadence.worthSending(here, here.copy(at = 1, stopped = true)), "a stop always goes")
    }

    @Test fun `distances and times read like a person would say them`() {
        assertEquals("350 m", Words.distance(347.0))
        assertEquals("12 km", Words.distance(12_400.0))
        assertEquals("now", Words.ago(20))
        assertEquals("5 min ago", Words.ago(330))
        assertEquals("1 h 30 min left", Words.remaining(5400))
        assertEquals("482 913", Words.code("482913"))
    }

    @Test fun `metres agree with the server's formula`() {
        // One degree of latitude, about 111.2 km — the same check the server's tests make.
        assertEquals(111_195.0, Geo.metres(36.0, 59.0, 37.0, 59.0), 50.0)
    }

    @Test fun `a point lands in the right tile, at the right place in it`() {
        // Tile 9/337/201 is the one the server's own tile tests use for Mashhad.
        val s = Tiles.spot(36.297, 59.606, 9)
        assertEquals(337, s.x)
        assertEquals(201, s.y)
        assertTrue(s.px in 0.0..256.0 && s.py in 0.0..256.0)
        // The top edge of a row really is that row's boundary.
        val top = Tiles.latitudeOfRow(201, 9)
        assertEquals(201, Tiles.spot(top - 1e-9, 59.606, 9).y)
        assertEquals(200, Tiles.spot(top + 1e-9, 59.606, 9).y)
    }
}
