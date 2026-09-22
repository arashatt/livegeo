// swift-tools-version:5.9
// The Apple Watch app's logic, apart from the app: the client, the offline
// outbox, sharing sessions, the send cadence. Foundation only, so `swift test`
// runs it on a Mac without a simulator, and the app target depends on it.
import PackageDescription

let package = Package(
    name: "LivegeoCore",
    platforms: [.watchOS(.v10), .macOS(.v13), .iOS(.v17)],
    products: [.library(name: "LivegeoCore", targets: ["LivegeoCore"])],
    targets: [
        .target(name: "LivegeoCore"),
        .testTarget(name: "LivegeoCoreTests", dependencies: ["LivegeoCore"]),
    ]
)
