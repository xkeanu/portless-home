// swift-tools-version: 5.9
// Native menu bar app for homeport. Core is a library so its pure
// functions (snapshot parsing, port lookup, menu model) are testable;
// the executable adds AppKit on top. Assemble the .app with ./build.sh.
import PackageDescription

let package = Package(
    name: "Homeport",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "HomeportCore"),
        .executableTarget(name: "Homeport", dependencies: ["HomeportCore"]),
        .testTarget(name: "HomeportCoreTests", dependencies: ["HomeportCore"]),
    ]
)
