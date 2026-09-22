package org.livegeo.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The watch's client against a real livegeo server, when one is given:
 *
 *   LIVEGEO_TEST_SERVER=http://127.0.0.1:8091 LIVEGEO_TEST_CODE=482913 ./gradlew :core:test
 *
 * The unit tests check the client against what the server's README says it
 * does; this checks it against what the server actually does, which is the
 * only way to find out the two have drifted. Skipped when no server is named.
 */
class AgainstServerTest {
    private val server = System.getenv("LIVEGEO_TEST_SERVER")
    private val code = System.getenv("LIVEGEO_TEST_CODE")

    @Test fun `pair, report, see yourself, and be refused once unpaired`() {
        if (server.isNullOrBlank() || code.isNullOrBlank()) return
        val api = Api(server)

        val paired = api.pair(code, "Test watch", "wearos").getOrThrow()
        assertTrue(paired.token.length > 30, "a long token")

        val now = System.currentTimeMillis() / 1000
        val result = api.report(listOf(
            Fix(36.2970, 59.6060, accuracy = 6.0, at = now - 30),
            Fix(36.2990, 59.6060, accuracy = 6.0, at = now),
            Fix(99.0, 0.0, at = now),
        )).getOrThrow()
        assertEquals(2, result.accepted)
        assertEquals("position out of range", result.rejected.single().error)

        val me = api.people().getOrThrow().single { it.id == paired.ownerId }
        assertEquals(36.2990, me.lat!!, 1e-9)
        assertTrue(me.live)

        // A token the server does not know is what an unpaired watch holds.
        api.token = "not-a-device"
        assertIs<Failure.Unpaired>(api.people().exceptionOrNull())
    }
}
