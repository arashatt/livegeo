package org.livegeo.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

// What the phone app (android/) adds to the core: finding the map's address
// in what Telegram shares, telling why the map did not load, and pairing with
// the session it is already signed in with.

class LinksTest {
    @Test fun `the link is found in the whole message Telegram shares`() {
        val shared = "https://calm-river-12.trycloudflare.com/auth/Zx9_q-1\n\nOpens once, within 10 minutes."
        assertEquals("https://calm-river-12.trycloudflare.com/auth/Zx9_q-1", Links.find(shared))
        assertEquals("https://calm-river-12.trycloudflare.com/auth/abc", Links.find("Sign in: https://calm-river-12.trycloudflare.com/auth/abc."),
            "a full stop after the link is not part of it")
        assertEquals("https://a.example/auth/x", Links.find("(https://a.example/auth/x)"))
    }

    @Test fun `only an https address counts as the map`() {
        assertNull(Links.find("http://a.example/auth/x"), "plain http would send the session unencrypted")
        assertNull(Links.find("no link here"))
        assertNull(Links.find(null))
        assertEquals("https://b.example/auth/y", Links.find("http://a.example/x then https://b.example/auth/y"),
            "the first usable one, not just the first")
    }

    @Test fun `an origin is scheme, host and port, and nothing unsafe`() {
        assertEquals("https://calm-river-12.trycloudflare.com", Links.origin("https://Calm-River-12.TryCloudflare.com/auth/x?y=1"))
        assertEquals("https://map.example", Links.origin("https://map.example:443/"), "the default port is left out")
        assertEquals("https://map.example:8443", Links.origin("https://map.example:8443/x"))
        assertNull(Links.origin("https://user:pw@map.example/"), "credentials in the address")
        assertNull(Links.origin("https://localhost/"), "a bare name")
        assertNull(Links.origin("javascript:alert(1)"))
        assertNull(Links.origin("https://bad host.example/"))
    }

    @Test fun `a sign-in link is told apart, and other origins are not the map`() {
        assertTrue(Links.isSignIn("https://a.example/auth/Zx9"))
        assertFalse(Links.isSignIn("https://a.example/"))
        assertFalse(Links.isSignIn("https://a.example/lib/auth/x"))
        assertTrue(Links.sameOrigin("https://a.example/api/me", "https://a.example"))
        assertFalse(Links.sameOrigin("https://www.openstreetmap.org/copyright", "https://a.example"))
        assertFalse(Links.sameOrigin("http://a.example/", "https://a.example"), "the same name over plain http is not the same place")
    }
}

class ReachTest {
    @Test fun `why the map did not load`() {
        assertEquals(Trouble.NO_NETWORK, Reach.trouble(networkUp = false, errorCode = Reach.ERROR_HOST_LOOKUP),
            "without a network nothing resolves; that says nothing about the address")
        assertEquals(Trouble.MOVED, Reach.trouble(networkUp = true, errorCode = Reach.ERROR_HOST_LOOKUP))
        assertEquals(Trouble.MOVED, Reach.trouble(networkUp = true, status = 530), "Cloudflare's answer for a tunnel that is gone")
        assertEquals(Trouble.DOWN, Reach.trouble(networkUp = true, status = 502), "the tunnel is there, the server behind it is not")
        assertEquals(Trouble.DOWN, Reach.trouble(networkUp = true, errorCode = Reach.ERROR_TIMEOUT))
    }

    @Test fun `only a server error on the page itself counts as failing to load`() {
        assertTrue(Reach.isFailure(530))
        assertTrue(Reach.isFailure(502))
        assertFalse(Reach.isFailure(401), "signed out: the server's own page says how to get in")
        assertFalse(Reach.isFailure(404))
        assertFalse(Reach.isFailure(200))
    }
}

class PairWithSessionTest {
    private class Recorder(private val answer: HttpResponse) : Transport {
        val calls = mutableListOf<Triple<String, String, Map<String, String>>>()
        override fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse {
            calls += Triple(method, url, headers)
            return answer
        }
    }

    @Test fun `a code is asked for with the session, and nothing else`() {
        val t = Recorder(HttpResponse(200, """{"code":"482913","expiresIn":300}"""))
        val api = Api("https://map.example/", t, token = "old-device-token")
        assertEquals("482913", api.code("livegeo_session=abc").getOrThrow())
        val (method, url, headers) = t.calls.single()
        assertEquals("POST", method)
        assertEquals("https://map.example/api/devices/code", url)
        assertEquals("livegeo_session=abc", headers["cookie"])
        assertNull(headers["authorization"], "a device token is not a person's session")
    }

    @Test fun `each refusal says what to do`() {
        fun asking(status: Int, body: String = "") = Api("https://m.example", Recorder(HttpResponse(status, body))).code("s=1").exceptionOrNull()
        assertEquals("sign in to the map first", asking(401, "Sign in first")?.message)
        assertEquals("this map cannot pair devices for this sign-in", asking(404, """{"error":"not found"}""")?.message)
        assertIs<Failure.Limited>(asking(429, """{"error":"slow down"}"""))
        assertIs<Failure.Server>(asking(500))
        val offline = Api("https://m.example", { _, _, _, _ -> throw java.net.UnknownHostException("m.example") }).code("s=1").exceptionOrNull()
        assertIs<Failure.Offline>(offline)
    }

    @Test fun `who the session is, to check it is who the phone is paired to`() {
        val t = Recorder(HttpResponse(200, """{"id":"42","name":"Ada","admin":false}"""))
        assertEquals("42", Api("https://map.example", t).whoIs("livegeo_session=abc").getOrThrow())
        assertEquals("GET", t.calls.single().first)
        assertEquals("https://map.example/api/me", t.calls.single().second)
        assertEquals("livegeo_session=abc", t.calls.single().third["cookie"])
        assertNull(Api("https://m.example", Recorder(HttpResponse(200, """{"id":null}"""))).whoIs("s=1").getOrThrow(),
            "the shared token is nobody in particular")
        assertEquals("7", Api("https://m.example", Recorder(HttpResponse(200, """{"id":7}"""))).whoIs("s=1").getOrThrow())
        assertEquals("sign in to the map first", Api("https://m.example", Recorder(HttpResponse(401, "no"))).whoIs("s=1").exceptionOrNull()?.message)
    }
}
