// swift-tools-version: 5.9
// Native menu bar app for portless-home. Core is a library so its pure
// functions (snapshot parsing, port lookup, menu model) are testable;
// the executable adds AppKit on top. Assemble the .app with ./build.sh.
import PackageDescription

let package = Package(
    name: "PortlessHome",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "PortlessHomeCore"),
        .executableTarget(name: "PortlessHome", dependencies: ["PortlessHomeCore"]),
        .testTarget(name: "PortlessHomeCoreTests", dependencies: ["PortlessHomeCore"]),
    ]
)
