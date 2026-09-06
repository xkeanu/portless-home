import XCTest
@testable import PortlessHomeCore

final class ModelTests: XCTestCase {
    let home = URL(string: "http://127.0.0.1:5995/")!
    let service = Service(label: "sh.portless.home", plist: URL(fileURLWithPath: "/tmp/x.plist"))

    func testParseAppsKeepsUsableEntries() {
        let body = """
        {"device":"mac","apps":[
          {"hostname":"web.localhost","label":"Web","tailscaleUrl":"https://mac.example.ts.net:8443","up":true},
          {"hostname":"scratch.localhost","label":"scratch","up":false},
          {"hostname":"evil.localhost","label":"evil","tailscaleUrl":"javascript:alert(1)","up":true},
          {"hostname":"nolabel.localhost","up":true},
          "junk"
        ]}
        """
        let apps = parseApps(Data(body.utf8))
        XCTAssertEqual(apps, [
            App(label: "Web", url: URL(string: "https://mac.example.ts.net:8443"), up: true),
            App(label: "scratch", url: nil, up: false),
            App(label: "evil", url: nil, up: true),
        ])
    }

    func testParseAppsRejectsNonSnapshots() {
        XCTAssertNil(parseApps(Data("not json".utf8)))
        XCTAssertNil(parseApps(Data("[]".utf8)))
        XCTAssertNil(parseApps(Data("{\"device\":\"mac\"}".utf8)))
        XCTAssertEqual(parseApps(Data("{\"apps\":[]}".utf8)), [])
    }

    func testPortFromPlist() {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>sh.portless.home</string>
          <key>EnvironmentVariables</key><dict><key>PORT</key><string>6001</string></dict>
        </dict></plist>
        """
        XCTAssertEqual(port(fromPlist: Data(plist.utf8)), 6001)
        XCTAssertEqual(port(fromPlist: nil), 5995)
        XCTAssertEqual(port(fromPlist: Data("garbage".utf8)), 5995)
        XCTAssertEqual(port(fromPlist: Data("<plist version=\"1.0\"><dict><key>Label</key><string>x</string></dict></plist>".utf8)), 5995)
    }

    func testServerURL() {
        XCTAssertEqual(serverURL(environment: [:], port: 6001), URL(string: "http://127.0.0.1:6001/"))
        XCTAssertEqual(serverURL(environment: ["PORTLESS_HOME_URL": "http://localhost:7000"], port: 6001),
                       URL(string: "http://localhost:7000"))
    }

    func testInstalledServicePrefersInstallScriptAgent() {
        let agents = URL(fileURLWithPath: "/Users/me/Library/LaunchAgents")
        let both = Service.installed(agents: agents, exists: { _ in true })
        XCTAssertEqual(both?.label, "sh.portless.home")
        XCTAssertEqual(both?.plist.path, "/Users/me/Library/LaunchAgents/sh.portless.home.plist")
        let brew = Service.installed(agents: agents, exists: { $0.lastPathComponent.hasPrefix("homebrew") })
        XCTAssertEqual(brew?.label, "homebrew.mxcl.portless-home")
        XCTAssertNil(Service.installed(agents: agents, exists: { _ in false }))
    }

    func testMenuWhenUp() {
        let web = App(label: "Web", url: URL(string: "https://mac.example.ts.net:8443"), up: true)
        let entries = menu(apps: [web], home: home, service: service, launchAtLogin: true)
        XCTAssertEqual(entries, [
            .open(title: "Open home page", url: home), .separator,
            .app(web),
            .separator, .service(.restart), .service(.stop),
            .separator, .launchAtLogin(enabled: true), .refresh, .quit,
        ])
    }

    func testMenuWhenUpWithNothingRunningAndNoService() {
        let entries = menu(apps: [], home: home, service: nil, launchAtLogin: false)
        XCTAssertEqual(entries, [
            .open(title: "Open home page", url: home), .separator,
            .text("Nothing running. Start an app through portless."),
            .separator, .launchAtLogin(enabled: false), .refresh, .quit,
        ])
    }

    func testMenuWhenDown() {
        XCTAssertEqual(menu(apps: nil, home: home, service: service, launchAtLogin: false), [
            .text("portless-home is not running"), .service(.start),
            .separator, .launchAtLogin(enabled: false), .refresh, .quit,
        ])
        XCTAssertEqual(menu(apps: nil, home: home, service: nil, launchAtLogin: false), [
            .text("portless-home is not running"),
            .text("No login service found — ./install.sh or brew services start portless-home"),
            .separator, .launchAtLogin(enabled: false), .refresh, .quit,
        ])
    }

    func testTitleCountsHealthyApps() {
        XCTAssertEqual(title(apps: nil), "–")
        XCTAssertEqual(title(apps: []), "0")
        XCTAssertEqual(title(apps: [App(label: "a", url: nil, up: true), App(label: "b", url: nil, up: false)]), "1")
    }
}
