package org.livegeo.core

import java.net.URI

// Where the map is, for the phone app. Its address is not built in: behind a
// quick tunnel it changes every time cloudflared restarts. The app learns it
// from the sign-in link the bot sends for /login, which always carries the
// address of the day, and from nothing else.

object Links {
    private val WEB = Regex("""https?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)

    // What follows a link in a sentence without being part of it.
    private val TRAILING = charArrayOf('.', ',', ';', ':', '!', '?', ')', ']', '}', '»', '"', '\'')

    /**
     * The first map address in [text]. What Telegram shares is often the
     * whole message ("https://…/auth/… Opens once, for 10 minutes"), not just
     * the link in it.
     */
    fun find(text: String?): String? {
        if (text == null) return null
        for (match in WEB.findAll(text)) {
            val url = match.value.trimEnd(*TRAILING)
            if (origin(url) != null) return url
        }
        return null
    }

    /**
     * The scheme, host and port of [url], or null for anything the app must
     * not treat as the map: plain http, which would carry the session cookie
     * unencrypted; credentials inside the address; a name with no dot in it.
     */
    fun origin(url: String): String? {
        val u = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        if (!"https".equals(u.scheme, ignoreCase = true)) return null
        val host = u.host?.lowercase() ?: return null
        if (u.rawUserInfo != null) return null
        if (!host.contains('.') || host.startsWith('.') || host.endsWith('.')) return null
        val port = if (u.port == -1 || u.port == 443) "" else ":${u.port}"
        return "https://$host$port"
    }

    /** A one-time sign-in link from the bot's /login. */
    fun isSignIn(url: String): Boolean =
        runCatching { URI(url.trim()).rawPath.orEmpty().startsWith("/auth/") }.getOrDefault(false)

    /** Whether [url] is on the map at [origin]; anything else opens outside the app. */
    fun sameOrigin(url: String, origin: String): Boolean = origin(url) == origin
}

/** Why the map did not load, which decides what the screen says and offers. */
enum class Trouble {
    /** The phone has no working connection. */
    NO_NETWORK,

    /** The address no longer leads anywhere: the tunnel restarted under a new name. */
    MOVED,

    /** The address is right but nothing answers behind it, or the answer is an error. */
    DOWN,
}

object Reach {
    // android.webkit.WebViewClient's codes, repeated here so the rule is plain
    // Kotlin and tested where the tests run.
    const val ERROR_HOST_LOOKUP = -2
    const val ERROR_CONNECT = -6
    const val ERROR_TIMEOUT = -8

    /**
     * A quick tunnel that is gone either stops resolving, or Cloudflare
     * answers for it with 530 (its error 1033). A 502 means the tunnel is
     * there and the server behind it is not.
     */
    fun trouble(networkUp: Boolean, errorCode: Int? = null, status: Int? = null): Trouble = when {
        !networkUp -> Trouble.NO_NETWORK
        errorCode == ERROR_HOST_LOOKUP || status == 530 -> Trouble.MOVED
        else -> Trouble.DOWN
    }

    /**
     * Whether the answer to loading the page itself means the map is not
     * there. A 4xx is the server's own page (signed out, not found) and is
     * shown as it is.
     */
    fun isFailure(status: Int): Boolean = status in 500..599
}
