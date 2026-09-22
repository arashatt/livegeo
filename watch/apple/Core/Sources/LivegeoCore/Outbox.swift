import Foundation

// Fixes waiting to be sent. Signal comes and goes on a wrist — a lift, a
// tunnel, a hike — and a fix taken then is still where somebody was. So every
// fix goes in here first, and the outbox is emptied in batches whenever the
// network allows, oldest first, with the times they were taken. The server
// files anything older than the live marker as history rather than moving the
// marker back. Same rules as the Galaxy Watch's Outbox.kt.

/// Where the outbox survives the app being killed. The app backs it with a file.
public protocol Shelf: AnyObject {
    func load() -> Data?
    func save(_ data: Data)
}

public final class MemoryShelf: Shelf {
    public var data: Data?
    public init(_ data: Data? = nil) { self.data = data }
    public func load() -> Data? { data }
    public func save(_ data: Data) { self.data = data }
}

public final class FileShelf: Shelf {
    private let url: URL
    public init(url: URL) { self.url = url }
    public func load() -> Data? { try? Data(contentsOf: url) }
    // Atomic, so a kill mid-write cannot leave half a file that loses
    // everything that was waiting.
    public func save(_ data: Data) { try? data.write(to: url, options: .atomic) }
}

public final class Outbox {
    private var waiting: [Fix] = []
    private let shelf: Shelf
    private let capacity: Int
    private let maxAge: Int64
    private let batch: Int

    public init(shelf: Shelf = MemoryShelf(), capacity: Int = 5_000, maxAge: Int64 = 24 * 3600, batch: Int = 500) {
        self.shelf = shelf
        self.capacity = capacity
        self.maxAge = maxAge
        self.batch = batch
        // A damaged file is not fatal: whatever cannot be read is dropped and
        // sharing carries on.
        if let data = shelf.load(), let fixes = try? JSONDecoder().decode([Fix].self, from: data) {
            waiting = fixes
        }
    }

    public var count: Int { waiting.count }

    public func add(_ fix: Fix) {
        waiting.append(fix)
        // Full: the oldest goes first. A recent fix says more about where
        // somebody is than one from yesterday morning.
        if waiting.count > capacity { waiting.removeFirst(waiting.count - capacity) }
        persist()
    }

    /// Sends what is waiting, a batch at a time, stopping at the first failure
    /// so nothing is lost. Returns how many were delivered.
    public func drain(now: Int64, send: ([Fix]) async -> Result<Void, Failure>) async -> Result<Int, Failure> {
        // The server refuses anything older than a day, so it is not kept.
        waiting.removeAll { $0.at < now - maxAge }
        var delivered = 0
        while !waiting.isEmpty {
            let next = Array(waiting.prefix(batch))
            if case .failure(let f) = await send(next) {
                persist()
                return .failure(f)
            }
            waiting.removeFirst(next.count)
            delivered += next.count
        }
        persist()
        return .success(delivered)
    }

    public func clear() {
        waiting.removeAll()
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(waiting) { shelf.save(data) }
    }
}
