package org.livegeo.core

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// What the watch adds to pairing: finding the map from a name typed on the
// watch, since behind a quick tunnel its address changes and cannot be built
// into the app; saying which installation is pairing, so pairing again after
// a move replaces the old entry; and telling a moved map from no signal.

class MapNameTest {
    private val tunnel = "https://calm-river-12-bird.trycloudflare.com"

    @Test fun `a quick tunnel's words find it, however the keyboard typed them`() {
        assertEquals(tunnel, Links.mapAddress("calm river 12 bird"))
        assertEquals(tunnel, Links.mapAddress("calm-river-12-bird"))
        assertEquals(tunnel, Links.mapAddress("  Calm River 12  Bird "), "a capital the keyboard put first, and spare spaces")
        assertEquals(tunnel, Links.mapAddress("calm, river, 12, bird"), "a voice keyboard's commas")
    }

    @Test fun `any other address is its host, or a whole link`() {
        assertEquals("https://livegeo.me.workers.dev", Links.mapAddress("livegeo.me.workers.dev"))
        assertEquals("https://livegeo.me.workers.dev", Links.mapAddress("https://livegeo.me.workers.dev/auth/x"))
        assertEquals("https://map.example:8443", Links.mapAddress("map.example:8443"))
        assertEquals(tunnel, Links.mapAddress("calm river 12 bird.trycloudflare.com"), "the whole host, with spaces for hyphens")
    }

    @Test fun `nothing that could not be a map`() {
        assertNull(Links.mapAddress(null))
        assertNull(Links.mapAddress("   "))
        assertNull(Links.mapAddress("- , -"))
        assertNull(Links.mapAddress("http://livegeo.me.workers.dev"), "never plain http: the token would travel unencrypted")
        assertNull(Links.mapAddress("x".repeat(64)), "longer than a name in an address can be")
    }

    @Test fun `the watch shows the name the way it is asked for`() {
        assertEquals("calm river 12 bird", Links.mapName(tunnel))
        assertEquals("livegeo.me.workers.dev", Links.mapName("https://livegeo.me.workers.dev"))
        assertEquals("map.example:8443", Links.mapName("https://map.example:8443"))
        for (origin in listOf(tunnel, "https://livegeo.me.workers.dev", "https://map.example:8443")) {
            assertEquals(origin, Links.mapAddress(Links.mapName(origin)), "typing back what is shown finds the same map")
        }
    }
}

class MovedTest {
    @Test fun `a map that moved is told apart from a watch with no signal`() {
        val gone = Failure.Offline(java.net.UnknownHostException("calm-river-12-bird.trycloudflare.com"))
        assertTrue(Reach.moved(gone, networkUp = true), "the name no longer resolves")
        assertTrue(Reach.moved(Failure.Server(530, "error code: 1033"), networkUp = true), "Cloudflare's answer for a tunnel that is gone")
        assertFalse(Reach.moved(gone, networkUp = false), "offline, nothing resolves: that says nothing about the map")
        assertFalse(Reach.moved(Failure.Server(502, "Bad Gateway"), networkUp = true), "the tunnel is there, the server behind it is not")
        assertFalse(Reach.moved(Failure.Offline(java.net.ConnectException("refused")), networkUp = true))
        assertFalse(Reach.moved(Failure.Unpaired(), networkUp = true))
        assertFalse(Reach.moved(null, networkUp = true))
    }

    @Test fun `a failure keeps what caused it`() {
        val cause = java.net.UnknownHostException("gone.example")
        val failed = Api("https://gone.example", { _, _, _, _ -> throw cause }).people().exceptionOrNull()
        assertEquals(cause, failed?.cause)
    }
}

class PairAgainTest {
    @Test fun `pairing says which installation it is, when it knows`() {
        val sent = mutableListOf<String?>()
        val answer = HttpResponse(200, """{"token":"t","id":9,"owner":{"id":"42","name":"Ada"}}""")
        val api = Api("https://map.example", { _, _, _, body -> sent += body; answer })
        api.pair("482913", "Xiaomi Watch 2 Pro", "wearos", install = "3f2a9c0e5b7d41a8a6e2c1b0d9f8e7a6").getOrThrow()
        api.pair("482913", "Watch", "wearos").getOrThrow()
        assertEquals("3f2a9c0e5b7d41a8a6e2c1b0d9f8e7a6", JSONObject(sent[0]!!).getString("install"))
        assertFalse(JSONObject(sent[1]!!).has("install"), "the phone pairs without one, as before")
    }
}
