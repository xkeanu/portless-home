// AppKit shell around PortlessHomeCore: the status item, its menu, the 15s
// poll of /api/routes, launchctl for the login service, and launch-at-login.
import AppKit
import PortlessHomeCore
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let service = Service.installed(
        agents: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents"),
        exists: { FileManager.default.fileExists(atPath: $0.path) })
    private lazy var home = serverURL(
        environment: ProcessInfo.processInfo.environment,
        port: port(fromPlist: service.flatMap { try? Data(contentsOf: $0.plist) }))
    private var apps: [App]?
    private var entries: [Entry] = []
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_: Notification) {
        item.button?.image = icon()
        item.button?.imagePosition = .imageLeading
        item.menu = NSMenu()
        item.menu?.delegate = self
        render()
        refresh()
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func menuWillOpen(_: NSMenu) { refresh() }

    // Same design as the page's icon: a rounded square with a dot. Template,
    // so it follows the menu bar's light/dark appearance.
    private func icon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let square = NSBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 1.5), xRadius: 4, yRadius: 4)
            square.lineWidth = 1.5
            square.stroke()
            NSBezierPath(ovalIn: rect.insetBy(dx: 5.5, dy: 5.5)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    private func refresh() {
        session.dataTask(with: home.appendingPathComponent("api/routes")) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                self?.apps = data.flatMap(parseApps)
                self?.render()
            }
        }.resume()
    }

    private func render() {
        item.button?.title = " " + title(apps: apps)
        item.button?.appearsDisabled = apps == nil
        // Rebuilding while the menu is open resets its highlight, so skip no-ops.
        let fresh = PortlessHomeCore.menu(
            apps: apps, home: home, service: service,
            launchAtLogin: SMAppService.mainApp.status == .enabled)
        guard fresh != entries, let menu = item.menu else { return }
        entries = fresh
        menu.removeAllItems()
        for entry in entries { menu.addItem(menuItem(entry)) }
    }

    private func menuItem(_ entry: Entry) -> NSMenuItem {
        switch entry {
        case .separator:
            return .separator()
        case .text(let text):
            let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            item.isEnabled = false
            return item
        case .home(let url):
            return action("Open home page", url: url)
        case .app(let app):
            let dot = app.up ? "●" : "○"
            guard let url = app.url else {
                let item = NSMenuItem(title: "\(dot) \(app.label) — local only", action: nil, keyEquivalent: "")
                item.isEnabled = false
                return item
            }
            return action("\(dot) \(app.label)", url: url)
        case .service(let action):
            let item = NSMenuItem(title: action.rawValue, action: #selector(runService(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = action
            return item
        case .launchAtLogin(let enabled):
            let item = NSMenuItem(title: "Launch at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
            item.target = self
            item.state = enabled ? .on : .off
            return item
        case .refresh:
            let item = NSMenuItem(title: "Refresh", action: #selector(refreshNow), keyEquivalent: "r")
            item.target = self
            return item
        case .quit:
            return NSMenuItem(title: "Quit Portless Home", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        }
    }

    private func action(_ title: String, url: URL) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(open(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = url
        return item
    }

    @objc private func open(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { NSWorkspace.shared.open(url) }
    }

    @objc private func refreshNow() { refresh() }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("launch at login: %@", error.localizedDescription)
        }
        render()
    }

    // Mirrors the plugin: bootstrap+kickstart to start, bootout to stop,
    // kickstart -k to restart. The refresh after 1s picks up the new state.
    @objc private func runService(_ sender: NSMenuItem) {
        guard let service, let action = sender.representedObject as? ServiceAction else { return }
        let domain = "gui/\(getuid())"
        let commands: [[String]]
        switch action {
        case .start: commands = [["bootstrap", domain, service.plist.path], ["kickstart", "\(domain)/\(service.label)"]]
        case .stop: commands = [["bootout", "\(domain)/\(service.label)"]]
        case .restart: commands = [["kickstart", "-k", "\(domain)/\(service.label)"]]
        }
        DispatchQueue.global().async { [weak self] in
            for arguments in commands { launchctl(arguments) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.refresh() }
        }
    }
}

private func launchctl(_ arguments: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try? process.run()
    process.waitUntilExit()
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
