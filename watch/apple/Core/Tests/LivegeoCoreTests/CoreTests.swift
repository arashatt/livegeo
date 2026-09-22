import XCTest
@testable import LivegeoCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class WireTests: XCTestCase {
    func testFixesAreWrittenTheWayTheServerReadsThem() throws {
        let data = try JSONEncoder().encode([Fix(lat: 36.297, lon: 59.606, accuracy: 6, at: 1_790_000_000, until: 1_790_003_600)])
        let f = try XCTUnwrap((try JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first)
        XCTAssertEqual(f["lat"] as? Double, 36.297)
        XCTAssertEqual(f["at"] as? Int, 1_790_000_000)
        XCTAssertEqual(f["until"] as? Int, 1_790_003_600)
        XCTAssertNil(f["heading"], "absent values are left out, not sent as null")
        XCTAssertNil(f["stopped"], "only a stop says so")
    }

    func testAStopSaysSo() throws {
        let data = try JSONEncoder().encode([Fix(lat: 1, lon: 1, at: 1, stopped: true)])
        let f = try XCTUnwrap((try JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first)
        XCTAssertEqual(f["stopped"] as? Bool, true)
    }

    func testPeopleAreReadIncludingSomeoneWithNoPositionYet() throws {
        struct Body: Decodable { let people: [Person] }
        let json = #"{"people":[{"id":42,"name":"Ada","latitude":36.3,"longitude":59.6,"accuracy":8,"at":100,"live":true},{"id":"7","name":"","latitude":null,"longitude":null,"at":90,"live":false}]}"#
        let people = try JSONDecoder().decode(Body.self, from: Data(json.utf8)).people
        XCTAssertEqual(people[0].id, "42", "a numeric id is still an id")
        XCTAssertEqual(people[0].lat, 36.3)
        XCTAssertTrue(people[0].live)
        XCTAssertNil(people[1].lat)
        XCTAssertNil(people[1].accuracy)
    }
}

/// Answers instead of a network, and remembers what it was asked.
final class Recorder: Transport, @unchecked Sendable {
    var requests: [URLRequest] = []
    let answer: (URLRequest) throws -> (Int, String)
    init(_ answer: @escaping (URLRequest) throws -> (Int, String)) { self.answer = answer }
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        requests.append(request)
        let (status, body) = try answer(request)
        return (status, Data(body.utf8))
    }
}

final class ApiTests: XCTestCase {
    func testPairingKeepsTheTokenAndUsesItFromThenOn() async throws {
        let t = Recorder { r in
            r.url!.path.hasSuffix("/pair")
                ? (200, #"{"token":"abc","id":1,"owner":{"id":"42","name":"Ada"}}"#)
                : (200, #"{"people":[]}"#)
        }
        let api = Api(base: "https://map.test/", transport: t)
        let paired = try await api.pair(code: "482913", name: "Watch", platform: "watchos").get()
        XCTAssertEqual(paired, Paired(token: "abc", deviceId: 1, ownerId: "42", ownerName: "Ada"))
        XCTAssertNil(t.requests[0].value(forHTTPHeaderField: "authorization"), "pairing has no token to send yet")
        _ = try await api.people().get()
        XCTAssertEqual(t.requests[1].value(forHTTPHeaderField: "authorization"), "Bearer abc")
        XCTAssertEqual(t.requests[1].url?.absoluteString, "https://map.test/api/positions", "no doubled slash")
    }

    func testEachFailureIsOneTheScreensCanActOn() async {
        func failing(_ status: Int, _ body: String = "{}") -> Api {
            Api(base: "https://m", transport: Recorder { _ in (status, body) }, token: "t")
        }
        let unpaired = await failing(401).people()
        XCTAssertEqual(unpaired.failure, .unpaired)
        let limited = await failing(429, #"{"error":"too many wrong codes"}"#).pair(code: "1", name: "", platform: "")
        XCTAssertEqual(limited.failure, .limited("too many wrong codes"))
        let bad = await failing(404, #"{"error":"that code is wrong or has expired"}"#).pair(code: "1", name: "", platform: "")
        XCTAssertEqual(bad.failure, .badCode("that code is wrong or has expired"))
        let offline = await Api(base: "https://m", transport: Recorder { _ in throw URLError(.notConnectedToInternet) }).report([])
        guard case .offline = offline.failure else { return XCTFail("a lost connection should read as offline") }
    }
}

extension Result {
    // Spelled out: inside an extension of Result, a bare `Failure` means
    // Result's own generic parameter, not LivegeoCore's error type.
    var failure: LivegeoCore.Failure? {
        if case .failure(let f) = self { return f as? LivegeoCore.Failure }
        return nil
    }
}

final class OutboxTests: XCTestCase {
    private func fix(_ at: Int64) -> Fix { Fix(lat: 1, lon: 1, accuracy: 5, at: at) }

    func testNothingIsLostWhileOfflineAndItAllGoesWhenTheSignalReturns() async {
        let box = Outbox()
        for at in Int64(1001)...1003 { box.add(fix(at)) }
        let failed = await box.drain(now: 1010) { _ in .failure(.offline("tunnel")) }
        XCTAssertNotNil(failed.failure)
        XCTAssertEqual(box.count, 3, "a failed send keeps everything")
        var sent: [Fix] = []
        let ok = await box.drain(now: 1010) { sent += $0; return .success(()) }
        XCTAssertEqual(try? ok.get(), 3)
        XCTAssertEqual(sent.map(\.at), [1001, 1002, 1003], "oldest first, with the times they were taken")
    }

    func testSentInBatchesAndAFailurePartWayKeepsTheRest() async {
        let box = Outbox(batch: 2)
        for at in Int64(1)...5 { box.add(fix(at)) }
        var calls = 0
        let r = await box.drain(now: 10) { _ in calls += 1; return calls == 2 ? .failure(.offline("dropped")) : .success(()) }
        XCTAssertNotNil(r.failure)
        XCTAssertEqual(box.count, 3, "the first batch went; the rest wait")
    }

    func testOlderThanADayIsDropped() async {
        let box = Outbox()
        box.add(fix(0)); box.add(fix(100_000))
        var sent: [Fix] = []
        _ = await box.drain(now: 100_010) { sent += $0; return .success(()) }
        XCTAssertEqual(sent.map(\.at), [100_000])
    }

    func testWhenFullTheOldestGoes() async {
        let box = Outbox(capacity: 3)
        for at in Int64(1)...5 { box.add(fix(at)) }
        var sent: [Fix] = []
        _ = await box.drain(now: 10) { sent += $0; return .success(()) }
        XCTAssertEqual(sent.map(\.at), [3, 4, 5])
    }

    func testItSurvivesTheAppBeingKilled() async {
        let shelf = MemoryShelf()
        Outbox(shelf: shelf).add(Fix(lat: 36.5, lon: 59.1, heading: 90, at: 7, until: 99, stopped: true))
        var back: [Fix] = []
        _ = await Outbox(shelf: shelf).drain(now: 10) { back += $0; return .success(()) }
        XCTAssertEqual(back, [Fix(lat: 36.5, lon: 59.1, heading: 90, at: 7, until: 99, stopped: true)])
    }

    func testADamagedFileIsNotFatal() {
        XCTAssertEqual(Outbox(shelf: MemoryShelf(Data("garbage".utf8))).count, 0)
    }
}

final class SharingTests: XCTestCase {
    func testASessionEndsWhenItSaysOrNever() {
        let hour = Session(startedAt: 1000, length: .hour)
        XCTAssertTrue(hour.active(4599))
        XCTAssertFalse(hour.active(4600))
        XCTAssertEqual(hour.remaining(4000), 600)
        XCTAssertTrue(Session(startedAt: 1000, length: .untilStopped).active(10_000_000))
    }

    func testAFixIsSentOnlyWhenItSaysSomethingNew() {
        let here = Fix(lat: 36.3, lon: 59.6, accuracy: 10, at: 0)
        XCTAssertTrue(Cadence.worthSending(last: nil, next: here))
        var near = here; near.lat = 36.3001; near.at = 30          // ~11 m
        XCTAssertFalse(Cadence.worthSending(last: here, next: near))
        var far = here; far.lat = 36.301; far.at = 30              // ~110 m
        XCTAssertTrue(Cadence.worthSending(last: here, next: far))
        var poor = far; poor.accuracy = 200                         // a poor fix raises its own bar
        XCTAssertFalse(Cadence.worthSending(last: here, next: poor))
        var still = here; still.at = 300                            // quiet long enough: stay live
        XCTAssertTrue(Cadence.worthSending(last: here, next: still))
        var stop = here; stop.at = 1; stop.stopped = true
        XCTAssertTrue(Cadence.worthSending(last: here, next: stop))
    }

    func testDistancesAndTimesReadLikeAPersonWouldSayThem() {
        XCTAssertEqual(Words.distance(347), "350 m")
        XCTAssertEqual(Words.distance(12_400), "12 km")
        XCTAssertEqual(Words.ago(20), "now")
        XCTAssertEqual(Words.ago(330), "5 min ago")
        XCTAssertEqual(Words.remaining(5400), "1 h 30 min left")
        XCTAssertEqual(Words.code("482913"), "482 913")
    }

    func testMetresAgreeWithTheServersFormula() {
        XCTAssertEqual(Geo.metres(36, 59, 37, 59), 111_195, accuracy: 50)
    }
}

/// The client against a real livegeo server, when one is named:
///   LIVEGEO_TEST_SERVER=http://127.0.0.1:8091 LIVEGEO_TEST_CODE=482913 swift test
/// Skipped otherwise.
final class AgainstServerTests: XCTestCase {
    func testPairReportSeeYourselfAndBeRefusedOnceUnpaired() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["LIVEGEO_TEST_SERVER"], let code = env["LIVEGEO_TEST_CODE"] else {
            throw XCTSkip("no server named")
        }
        let api = Api(base: server)
        let paired = try await api.pair(code: code, name: "Test watch", platform: "watchos").get()
        let now = Int64(Date().timeIntervalSince1970)
        let result = try await api.report([
            Fix(lat: 36.2970, lon: 59.6060, accuracy: 6, at: now - 30),
            Fix(lat: 36.2990, lon: 59.6060, accuracy: 6, at: now),
            Fix(lat: 99, lon: 0, at: now),
        ]).get()
        XCTAssertEqual(result.accepted, 2)
        XCTAssertEqual(result.rejected.first?.error, "position out of range")
        let people = try await api.people().get()
        let me = try XCTUnwrap(people.first { $0.id == paired.ownerId })
        XCTAssertEqual(try XCTUnwrap(me.lat), 36.2990, accuracy: 1e-9)
        api.token = "not-a-device"
        let refused = await api.people()
        XCTAssertEqual(refused.failure, .unpaired)
    }
}
