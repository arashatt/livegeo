import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The things the watch asks the server. Behind a Transport so the tests can
// answer instead of a network.

public protocol Transport: Sendable {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

public struct URLSessionTransport: Transport {
    public init() {}
    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

/// What went wrong, in terms the screens can act on.
public enum Failure: Error, Equatable {
    /// The token is no longer good — removed from the map, or /stop. Pair again.
    case unpaired
    /// Wrong or expired pairing code.
    case badCode(String)
    /// Too many wrong codes; wait, then ask for a new one.
    case limited(String)
    /// No connection, or the server unreachable. Worth retrying later.
    case offline(String)
    case server(Int, String)
}

public final class Api {
    private let base: String
    private let transport: Transport
    public var token: String?

    public init(base: String, transport: Transport = URLSessionTransport(), token: String? = nil) {
        // A trailing slash on the base is not doubled.
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        self.base = b
        self.transport = transport
        self.token = token
    }

    private struct ErrorBody: Decodable { let error: String? }
    private struct PairedBody: Decodable {
        struct Owner: Decodable { let id: String; let name: String? }
        let token: String
        let id: Int64
        let owner: Owner
    }
    private struct PeopleBody: Decodable { let people: [Person] }
    private struct FixesBody: Encodable { let fixes: [Fix] }
    private struct PairRequest: Encodable { let code: String; let name: String; let platform: String }

    private func said(_ data: Data, _ status: Int) -> String {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "HTTP \(status)"
    }

    private func call(_ method: String, _ path: String, body: Data? = nil, auth: Bool = true) async -> Result<(Int, Data), Failure> {
        guard let url = URL(string: base + path) else { return .failure(.server(0, "bad server address")) }
        var r = URLRequest(url: url, timeoutInterval: 20)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "accept")
        if let body { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "content-type") }
        if auth, let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        do {
            let (status, data) = try await transport.send(r)
            return .success((status, data))
        } catch {
            return .failure(.offline(error.localizedDescription))
        }
    }

    private func fail(_ status: Int, _ data: Data) -> Failure {
        switch status {
        case 401: return .unpaired
        case 429: return .limited(said(data, status))
        default: return .server(status, said(data, status))
        }
    }

    public func pair(code: String, name: String, platform: String) async -> Result<Paired, Failure> {
        let body = try? JSONEncoder().encode(PairRequest(code: code, name: name, platform: platform))
        switch await call("POST", "/api/devices/pair", body: body, auth: false) {
        case .failure(let f): return .failure(f)
        case .success(let (status, data)):
            if status == 404 { return .failure(.badCode(said(data, status))) }
            guard status == 200, let p = try? JSONDecoder().decode(PairedBody.self, from: data) else {
                return .failure(fail(status, data))
            }
            token = p.token
            return .success(Paired(token: p.token, deviceId: p.id, ownerId: p.owner.id, ownerName: p.owner.name ?? ""))
        }
    }

    public func report(_ fixes: [Fix]) async -> Result<IngestResult, Failure> {
        let body = try? JSONEncoder().encode(FixesBody(fixes: fixes))
        switch await call("POST", "/api/ingest", body: body) {
        case .failure(let f): return .failure(f)
        case .success(let (status, data)):
            guard status == 200, let r = try? JSONDecoder().decode(IngestResult.self, from: data) else {
                return .failure(fail(status, data))
            }
            return .success(r)
        }
    }

    public func people() async -> Result<[Person], Failure> {
        switch await call("GET", "/api/positions") {
        case .failure(let f): return .failure(f)
        case .success(let (status, data)):
            guard status == 200, let p = try? JSONDecoder().decode(PeopleBody.self, from: data) else {
                return .failure(fail(status, data))
            }
            return .success(p.people)
        }
    }
}
