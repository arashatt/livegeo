package org.livegeo.core

import org.json.JSONArray
import org.json.JSONObject

// JSON in and out. org.json because Android ships it in the platform, so the
// watch app carries no JSON library of its own; the tests add it from Maven.
object Wire {
    fun fixes(fixes: List<Fix>): String {
        val list = JSONArray()
        for (f in fixes) {
            val o = JSONObject()
            o.put("lat", f.lat)
            o.put("lon", f.lon)
            f.accuracy?.let { o.put("accuracy", it) }
            f.heading?.let { o.put("heading", it) }
            o.put("at", f.at)
            f.until?.let { o.put("until", it) }
            if (f.stopped) o.put("stopped", true)
            list.put(o)
        }
        return JSONObject().put("fixes", list).toString()
    }

    fun pairRequest(code: String, name: String, platform: String): String =
        JSONObject().put("code", code).put("name", name).put("platform", platform).toString()

    fun paired(json: String): Paired {
        val o = JSONObject(json)
        val owner = o.getJSONObject("owner")
        return Paired(
            token = o.getString("token"),
            deviceId = o.getLong("id"),
            ownerId = owner.getString("id"),
            ownerName = owner.optString("name", ""),
        )
    }

    fun ingest(json: String): IngestResult {
        val o = JSONObject(json)
        val rejected = o.optJSONArray("rejected") ?: JSONArray()
        return IngestResult(
            accepted = o.optInt("accepted", 0),
            rejected = (0 until rejected.length()).map {
                val r = rejected.getJSONObject(it)
                Rejection(r.optInt("index", -1), r.optString("error", ""))
            },
        )
    }

    fun people(json: String): List<Person> {
        val list = JSONObject(json).optJSONArray("people") ?: return emptyList()
        return (0 until list.length()).map {
            val p = list.getJSONObject(it)
            Person(
                id = p.get("id").toString(),
                name = p.optString("name", ""),
                lat = if (p.isNull("latitude")) null else p.optDouble("latitude"),
                lon = if (p.isNull("longitude")) null else p.optDouble("longitude"),
                accuracy = if (p.isNull("accuracy") || !p.has("accuracy")) null else p.optDouble("accuracy"),
                at = p.optLong("at", 0),
                live = p.optBoolean("live", false),
            )
        }
    }

    /** The server's error message, when it sent one in the usual shape. */
    fun error(json: String): String? = runCatching { JSONObject(json).optString("error").ifBlank { null } }.getOrNull()
}
