// Pure parts of the menu bar app: no AppKit, no I/O beyond what's passed in.
import Foundation

/// One app from GET /api/routes. `url` is nil for local-only apps: the API
/// carries no port, so there is nothing to open for them.
public struct App: Equatable {
    public let label: String
    public let url: URL?
    public let up: Bool

    public init(label: String, url: URL?, up: Bool) {
        self.label = label
        self.url = url
        self.up = up
    }
}

/// Decodes the /api/routes body, dropping entries that aren't usable rather
/// than failing the whole list; the server is local but still input.
public func parseApps(_ data: Data) -> [App]? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let apps = json["apps"] as? [Any] else { return nil }
    return apps.compactMap { entry in
        guard let app = entry as? [String: Any],
              let label = app["label"] as? String, !label.isEmpty else { return nil }
        let url = (app["tailscaleUrl"] as? String).flatMap(URL.init(string:))
        let https = url?.scheme == "https" ? url : nil
        return App(label: label, url: https, up: app["up"] as? Bool ?? false)
    }
}

/// The login service that runs the server: install.sh's LaunchAgent, or the
/// one `brew services` writes. Checked in that order.
public struct Service: Equatable {
    public let label: String
    public let plist: URL

    public init(label: String, plist: URL) {
        self.label = label
        self.plist = plist
    }

    public static let labels = ["sh.portless.home", "homebrew.mxcl.portless-home"]

    public static func installed(agents: URL, exists: (URL) -> Bool) -> Service? {
        for label in labels {
            let plist = agents.appendingPathComponent("\(label).plist")
            if exists(plist) { return Service(label: label, plist: plist) }
        }
        return nil
    }
}

public let defaultPort = 5995

/// install.sh writes the chosen PORT into the plist; anything else means 5995.
public func port(fromPlist data: Data?) -> Int {
    guard let data,
          let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let env = plist["EnvironmentVariables"] as? [String: Any],
          let raw = env["PORT"] as? String, let port = Int(raw) else { return defaultPort }
    return port
}

/// Server base URL: PORTLESS_HOME_URL if set, else localhost on the port.
public func serverURL(environment: [String: String], port: Int) -> URL {
    if let override = environment["PORTLESS_HOME_URL"], let url = URL(string: override) { return url }
    return URL(string: "http://127.0.0.1:\(port)/")!
}

public enum ServiceAction: String, CaseIterable {
    case start = "Start service"
    case stop = "Stop service"
    case restart = "Restart service"
}

public enum Entry: Equatable {
    case open(title: String, url: URL)
    case app(App)
    case text(String)
    case service(ServiceAction)
    case launchAtLogin(enabled: Bool)
    case refresh
    case quit
    case separator
}

/// The whole dropdown. `apps` is nil when the server couldn't be reached.
public func menu(apps: [App]?, home: URL, service: Service?, launchAtLogin: Bool) -> [Entry] {
    var entries: [Entry] = []
    if let apps {
        entries += [.open(title: "Open home page", url: home), .separator]
        entries += apps.isEmpty ? [.text("Nothing running. Start an app through portless.")] : apps.map(Entry.app)
        if service != nil { entries += [.separator, .service(.restart), .service(.stop)] }
    } else {
        entries.append(.text("portless-home is not running"))
        if service != nil {
            entries.append(.service(.start))
        } else {
            entries.append(.text("No login service found — ./install.sh or brew services start portless-home"))
        }
    }
    entries += [.separator, .launchAtLogin(enabled: launchAtLogin), .refresh, .quit]
    return entries
}

/// Menu bar text next to the icon: apps passing the health probe, or a dash.
public func title(apps: [App]?) -> String {
    guard let apps else { return "–" }
    return String(apps.filter(\.up).count)
}
