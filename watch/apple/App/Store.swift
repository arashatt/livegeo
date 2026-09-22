import Foundation
import LivegeoCore
import Security

/// What the watch remembers between launches. The token is a credential —
/// it *is* the watch, to the server — so it lives in the Keychain, not in
/// UserDefaults with everything else.
struct Store {
    private let defaults = UserDefaults.standard
    private let service = "org.livegeo.watch"

    var token: String? {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: "token",
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var out: AnyObject?
            guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
                  let data = out as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        nonmutating set {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: "token",
            ]
            SecItemDelete(base as CFDictionary)
            guard let newValue else { return }
            var add = base
            add[kSecValueData as String] = Data(newValue.utf8)
            // Readable after the first unlock since boot, so sharing can keep
            // sending with the watch locked on a wrist.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    var ownerId: String? {
        get { defaults.string(forKey: "owner.id") }
        nonmutating set { defaults.set(newValue, forKey: "owner.id") }
    }

    var ownerName: String? {
        get { defaults.string(forKey: "owner.name") }
        nonmutating set { defaults.set(newValue, forKey: "owner.name") }
    }

    var session: Session? {
        guard defaults.object(forKey: "session.start") != nil,
              let length = ShareLength(rawValue: defaults.string(forKey: "session.length") ?? "") else { return nil }
        return Session(startedAt: Int64(defaults.integer(forKey: "session.start")), length: length)
    }

    func startSession(now: Int64, length: ShareLength) {
        defaults.set(Int(now), forKey: "session.start")
        defaults.set(length.rawValue, forKey: "session.length")
    }

    func endSession() {
        defaults.removeObject(forKey: "session.start")
        defaults.removeObject(forKey: "session.length")
    }

    /// Forget the pairing: the token was refused, or the wearer asked.
    func unpair() {
        token = nil
        ["owner.id", "owner.name", "session.start", "session.length"].forEach(defaults.removeObject(forKey:))
    }
}

enum Clock {
    static func now() -> Int64 { Int64(Date().timeIntervalSince1970) }
}

enum Server {
    /// Compiled in from the LIVEGEO_SERVER build setting.
    static let base = Bundle.main.object(forInfoDictionaryKey: "LivegeoServer") as? String ?? ""
    /// A build made without LIVEGEO_SERVER can only fail to pair; it says so instead.
    static var unset: Bool { base.isEmpty || base.contains("example.") }
}
