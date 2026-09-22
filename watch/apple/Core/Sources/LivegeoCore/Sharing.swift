import Foundation

// Sharing sessions, when to send, and how things read. Pure, so the rules
// that decide battery life are tested rather than hoped. The same rules as
// the Galaxy Watch's Sharing.kt.

/// How long to share: an hour, four, or until the wearer stops it.
public enum ShareLength: String, CaseIterable, Sendable {
    case hour, fourHours, untilStopped
    public var seconds: Int64? {
        switch self {
        case .hour: return 3600
        case .fourHours: return 4 * 3600
        case .untilStopped: return nil
        }
    }
}

public struct Session: Equatable, Sendable {
    public let startedAt: Int64
    public let length: ShareLength
    public init(startedAt: Int64, length: ShareLength) { self.startedAt = startedAt; self.length = length }
    /// When it ends, or nil for "until I stop".
    public var until: Int64? { length.seconds.map { startedAt + $0 } }
    public func active(_ now: Int64) -> Bool { until.map { now < $0 } ?? true }
    public func remaining(_ now: Int64) -> Int64? { until.map { max(0, $0 - now) } }
}

public enum Geo {
    /// Great-circle metres — the same formula the server uses.
    public static func metres(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let rad = Double.pi / 180
        let dLat = (lat2 - lat1) * rad
        let dLon = (lon2 - lon1) * rad
        let s = pow(sin(dLat / 2), 2) + cos(lat1 * rad) * cos(lat2 * rad) * pow(sin(dLon / 2), 2)
        return 2 * 6_371_000 * asin(min(1, s.squareRoot()))
    }
}

/// Whether a new fix is worth the radio time: moved further than its own
/// uncertainty (never less than `minMetres`), or quiet for `heartbeat` seconds
/// — which keeps somebody standing still showing as live.
public enum Cadence {
    public static func worthSending(last: Fix?, next: Fix, minMetres: Double = 25, heartbeat: Int64 = 300) -> Bool {
        guard let last, !next.stopped else { return true }
        if next.at - last.at >= heartbeat { return true }
        let threshold = max(minMetres, max(last.accuracy ?? 0, next.accuracy ?? 0))
        return Geo.metres(last.lat, last.lon, next.lat, next.lon) > threshold
    }
}

public enum Words {
    public static func distance(_ metres: Double) -> String {
        if metres < 1000 { return "\(Int((metres / 10).rounded()) * 10) m" }
        if metres < 10_000 { return String(format: "%.1f km", metres / 1000) }
        return "\(Int((metres / 1000).rounded())) km"
    }

    public static func ago(_ seconds: Int64) -> String {
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60) min ago" }
        if seconds < 86_400 { return "\(seconds / 3600) h ago" }
        return "\(seconds / 86_400) d ago"
    }

    public static func remaining(_ seconds: Int64) -> String {
        if seconds >= 3600 { return "\(seconds / 3600) h \((seconds % 3600) / 60) min left" }
        return "\(max(1, seconds / 60)) min left"
    }

    /// "482 913": six digits read more easily in two groups.
    public static func code(_ digits: String) -> String {
        digits.count > 3 ? String(digits.prefix(3)) + " " + String(digits.dropFirst(3)) : digits
    }
}
