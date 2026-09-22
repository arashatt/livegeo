import Foundation

// What the watch knows and says. The shapes mirror the server's own: a Fix is
// what POST /api/ingest takes (src/ingest.js), a Person is one entry of
// GET /api/positions. Times are seconds since the epoch, as on the server.

public struct Fix: Equatable, Sendable {
    public var lat: Double
    public var lon: Double
    public var accuracy: Double?
    public var heading: Double?
    public var at: Int64
    /// When this sharing session ends; the server caps it at a day.
    public var until: Int64?
    /// The last fix of a session: keeps the place, stops calling it live.
    public var stopped: Bool

    public init(lat: Double, lon: Double, accuracy: Double? = nil, heading: Double? = nil,
                at: Int64, until: Int64? = nil, stopped: Bool = false) {
        self.lat = lat; self.lon = lon; self.accuracy = accuracy; self.heading = heading
        self.at = at; self.until = until; self.stopped = stopped
    }
}

extension Fix: Codable {
    enum CodingKeys: String, CodingKey { case lat, lon, accuracy, heading, at, until, stopped }

    // Absent values are left out rather than sent as null, and only a stop
    // says "stopped" — the same as the Galaxy Watch sends.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(lat, forKey: .lat)
        try c.encode(lon, forKey: .lon)
        try c.encodeIfPresent(accuracy, forKey: .accuracy)
        try c.encodeIfPresent(heading, forKey: .heading)
        try c.encode(at, forKey: .at)
        try c.encodeIfPresent(until, forKey: .until)
        if stopped { try c.encode(true, forKey: .stopped) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lat = try c.decode(Double.self, forKey: .lat)
        lon = try c.decode(Double.self, forKey: .lon)
        accuracy = try c.decodeIfPresent(Double.self, forKey: .accuracy)
        heading = try c.decodeIfPresent(Double.self, forKey: .heading)
        at = try c.decode(Int64.self, forKey: .at)
        until = try c.decodeIfPresent(Int64.self, forKey: .until)
        stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false
    }
}

/// Somebody on the map, as far as the watch's owner may see.
public struct Person: Equatable, Identifiable, Sendable, Decodable {
    public var id: String
    public var name: String
    public var lat: Double?
    public var lon: Double?
    public var accuracy: Double?
    public var at: Int64
    public var live: Bool
    /// Inside one of their private places: `lat`/`lon` are the place's centre
    /// and `accuracy` its radius, never where they are in it. The server never
    /// sends that, so there is nothing more exact to show.
    public var hidden: Bool

    enum CodingKeys: String, CodingKey { case id, name, latitude, longitude, accuracy, at, live, hidden }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Telegram ids arrive as numbers from one ingest and strings from
        // another; either way it is the same person.
        if let n = try? c.decode(Int64.self, forKey: .id) { id = String(n) } else { id = try c.decode(String.self, forKey: .id) }
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        lat = try c.decodeIfPresent(Double.self, forKey: .latitude)
        lon = try c.decodeIfPresent(Double.self, forKey: .longitude)
        accuracy = try c.decodeIfPresent(Double.self, forKey: .accuracy)
        at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
        live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
    }

    public init(id: String, name: String, lat: Double?, lon: Double?, accuracy: Double?, at: Int64, live: Bool, hidden: Bool = false) {
        self.id = id; self.name = name; self.lat = lat; self.lon = lon; self.accuracy = accuracy; self.at = at; self.live = live
        self.hidden = hidden
    }
}

public struct Paired: Equatable, Sendable {
    public let token: String
    public let deviceId: Int64
    public let ownerId: String
    public let ownerName: String
}

public struct Rejection: Equatable, Sendable, Decodable {
    public let index: Int
    public let error: String
}

public struct IngestResult: Equatable, Sendable, Decodable {
    public let accepted: Int
    public let rejected: [Rejection]
}
