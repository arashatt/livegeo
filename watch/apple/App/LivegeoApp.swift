import LivegeoCore
import MapKit
import SwiftUI
import WatchKit

@main
struct LivegeoApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
        }
    }
}

/// The pieces the screens and the sharer share, made once.
@MainActor
final class AppModel: ObservableObject {
    @Published var paired: Bool
    @Published var people: [Person] = []
    @Published var status = ""

    let store = Store()
    let api: Api
    private let outbox: Outbox
    lazy var sharer = Sharer(model: self)

    init() {
        api = Api(base: Server.base, token: Store().token)
        let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        outbox = Outbox(shelf: FileShelf(url: file.appendingPathComponent("outbox.json")))
        paired = Store().token != nil
    }

    /// Queue a fix and try to send everything waiting.
    func report(_ fix: Fix) async {
        outbox.add(fix)
        await send()
    }

    /// A refused token means this watch was removed, or its owner sent /stop:
    /// nothing it holds is wanted any more, so the queue and the pairing go.
    func send() async {
        let result = await outbox.drain(now: Clock.now()) { [api] batch in
            await api.report(batch).map { _ in () }
        }
        if case .failure(.unpaired) = result { forget() }
    }

    func refresh() async {
        await send()
        switch await api.people() {
        case .success(let p): people = p; status = ""
        case .failure(.unpaired): forget()
        case .failure(.offline): status = "Offline — will retry"
        case .failure(let f): status = "\(f)"
        }
    }

    func pair(_ code: String) async -> String? {
        // The watch's own name ("Ada's Apple Watch"), so the Circle panel's
        // list of watches says which one this is.
        switch await api.pair(code: code, name: WKInterfaceDevice.current().name, platform: "watchos") {
        case .success(let p):
            store.token = p.token
            store.ownerId = p.ownerId
            store.ownerName = p.ownerName
            paired = true
            return nil
        case .failure(.badCode): return "Wrong or expired code"
        case .failure(.limited): return "Too many tries — wait"
        case .failure(.offline): return "No connection"
        case .failure(let f): return "\(f)"
        }
    }

    func forget() {
        sharer.stop()
        outbox.clear()
        store.unpair()
        api.token = nil
        paired = false
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.paired {
            // The sharer is observed directly, so starting or stopping a
            // session redraws the screen that shows it.
            NavigationStack { HomeView(sharer: model.sharer) }
        } else {
            PairView()
        }
    }
}

// ------------------------------------------------------------------ pairing

struct PairView: View {
    @EnvironmentObject var model: AppModel
    @State private var digits = ""
    @State private var message = Server.unset ? "No server in this build" : "Send /pair to the bot"
    @State private var busy = false

    private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"]

    var body: some View {
        VStack(spacing: 4) {
            Text(digits.isEmpty ? message : Words.code(digits))
                .font(.headline)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.6)
            // A keypad rather than the system keyboard: six digits, typed with
            // a fingertip on a screen the size of a coin.
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                ForEach(keys, id: \.self) { key in
                    Button(key) { press(key) }
                        .disabled(Server.unset || busy || (key == "✓" && digits.count != 6))
                        .buttonStyle(.bordered)
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private func press(_ key: String) {
        switch key {
        case "⌫": digits = String(digits.dropLast())
        case "✓":
            busy = true
            Task {
                if let problem = await model.pair(digits) { message = problem; digits = "" }
                busy = false
            }
        default: if digits.count < 6 { digits += key }
        }
    }
}

// --------------------------------------------------------------------- home

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var sharer: Sharer
    @State private var now = Clock.now()

    var body: some View {
        List {
            if let s = sharer.session, s.active(now) {
                Button {
                    sharer.stop()
                } label: {
                    VStack(alignment: .leading) {
                        Text("Stop sharing")
                        Text(s.remaining(now).map(Words.remaining) ?? "Until you stop").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } else {
                Button("Share for 1 hour") { sharer.start(.hour) }
                Button("Share for 4 hours") { sharer.start(.fourHours) }
                Button("Share until I stop") { sharer.start(.untilStopped) }
            }

            if !model.status.isEmpty { Text(model.status).font(.footnote) }

            let me = model.people.first { $0.id == model.store.ownerId }
            let others = model.people.filter { $0.id != model.store.ownerId }
            if others.isEmpty {
                Text("Nobody else yet. /invite in the bot adds people.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(others) { p in
                NavigationLink(value: p.id) {
                    VStack(alignment: .leading) {
                        Text(p.name.isEmpty ? p.id : p.name)
                        Text(detail(p, me: me)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(model.store.ownerName ?? "livegeo")
        .navigationDestination(for: String.self) { id in
            if let p = model.people.first(where: { $0.id == id }) { PersonView(person: p) }
        }
        // Asked while the screen is on, and not otherwise: a list nobody is
        // looking at is not worth the radio time.
        .task {
            while !Task.isCancelled {
                now = Clock.now()
                await model.refresh()
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
            }
        }
    }

    private func detail(_ p: Person, me: Person?) -> String {
        var parts: [String] = []
        if let a = me?.lat, let b = me?.lon, let c = p.lat, let d = p.lon {
            parts.append(Words.distance(Geo.metres(a, b, c, d)))
        }
        parts.append(Words.ago(now - p.at))
        if !p.live { parts.append("not live") }
        return parts.joined(separator: " · ")
    }
}

// ------------------------------------------------------------------- person

struct PersonView: View {
    let person: Person

    var body: some View {
        if let lat = person.lat, let lon = person.lon {
            let here = CLLocationCoordinate2D(latitude: lat, longitude: lon)
            Map(initialPosition: .region(MKCoordinateRegion(center: here, latitudinalMeters: 800, longitudinalMeters: 800))) {
                Marker(person.name.isEmpty ? person.id : person.name, coordinate: here)
            }
            .navigationTitle(Words.ago(Clock.now() - person.at))
        } else {
            Text("No position yet")
        }
    }
}
