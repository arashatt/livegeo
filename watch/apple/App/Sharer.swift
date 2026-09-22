import CoreLocation
import Foundation
import LivegeoCore

/// Sharing, while it lasts.
///
/// CLLocationUpdate.liveUpdates() delivers fixes; a CLBackgroundActivitySession
/// keeps them coming with the screen off, which is what makes a session
/// survive the wrist being lowered. Both are watchOS 10.
///
/// Battery is the constraint that matters on a watch, so a fix is sent only
/// when it says something new — see Cadence in the core — and every fix goes
/// through the outbox first, so losing signal loses nothing.
@MainActor
final class Sharer: ObservableObject {
    @Published private(set) var session: Session?

    private let store = Store()
    private let manager = CLLocationManager()
    private var updates: Task<Void, Never>?
    private var ending: Task<Void, Never>?
    private var background: CLBackgroundActivitySession?
    private var last: Fix?
    // Unowned: the model owns the sharer, and lives as long as the app.
    private unowned let model: AppModel

    init(model: AppModel) {
        self.model = model
        // A session started before the app was killed carries on, for as long
        // as the wearer chose.
        if let s = store.session, s.active(Clock.now()) { begin(s) } else { store.endSession() }
    }

    func start(_ length: ShareLength) {
        // "While in use" is enough: a session always starts here, in the
        // foreground, and the background session keeps it alive after.
        manager.requestWhenInUseAuthorization()
        store.startSession(now: Clock.now(), length: length)
        if let s = store.session { begin(s) }
    }

    func stop() {
        updates?.cancel(); updates = nil
        ending?.cancel(); ending = nil
        background?.invalidate(); background = nil
        // One last fix marked stopped keeps the place and ends "live" at once,
        // rather than the map waiting fifteen minutes to notice.
        if var final = last {
            final.at = Clock.now(); final.stopped = true; final.until = nil
            let fix = final
            Task { await model.report(fix) }
        }
        last = nil
        store.endSession()
        session = nil
    }

    private func begin(_ s: Session) {
        session = s
        background = CLBackgroundActivitySession()
        updates?.cancel()
        updates = Task { [weak self] in
            do {
                for try await update in CLLocationUpdate.liveUpdates() {
                    guard let self, !Task.isCancelled else { return }
                    if let location = update.location { await self.take(location) }
                }
            } catch {
                // The stream ended — location turned off, or permission taken
                // back. Sharing cannot continue without it.
                self?.stop()
            }
        }
        ending?.cancel()
        if let left = s.remaining(Clock.now()) {
            ending = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(left) * 1_000_000_000)
                guard !Task.isCancelled else { return }
                self?.stop()
            }
        }
    }

    private func take(_ l: CLLocation) async {
        guard let s = session, s.active(Clock.now()) else { return stop() }
        let fix = Fix(
            lat: l.coordinate.latitude,
            lon: l.coordinate.longitude,
            accuracy: l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil,
            heading: l.course >= 0 ? l.course : nil,
            at: Int64(l.timestamp.timeIntervalSince1970),
            until: s.until
        )
        guard Cadence.worthSending(last: last, next: fix) else { return }
        last = fix
        await model.report(fix)
    }
}
