import Foundation
import CryptoKit

struct RuntimeManifest: Decodable {
    struct Archive: Decodable { let url: String; let sha256: String; let bytes: Int }
    struct Bun: Decodable { let version: String; let arm64: Archive; let x86_64: Archive }
    struct Package: Decodable { let version: String; let tarball: String; let integrity: String; let gitHead: String; let bytes: Int }
    let mode: String
    let port: Int
    let bun: Bun
    let delegatus: Package
}

struct Installation {
    let bun: URL
    let cli: URL
    var environment: [String: String] = [:]
    var service: URL? = nil
}

enum Installations {
    static let marker = "<!-- Written by \"delegatus service install\". \"delegatus service remove\" deletes it. -->"
    static func runtime(_ home: URL) -> URL { home.appendingPathComponent("Library/Application Support/Delegatus/Runtime") }
    static func serviceFile(_ home: URL) -> URL { home.appendingPathComponent("Library/LaunchAgents/org.delegatus.server.plist") }
    static func withoutService(_ install: Installation) -> Installation {
        Installation(bun: install.bun, cli: install.cli, environment: install.environment)
    }

    static func serverPackageRoot(home: URL, environment: [String: String], install: Installation) -> URL {
        let base = install.cli.deletingLastPathComponent().deletingLastPathComponent()
        let configRoot = URL(fileURLWithPath: environment["XDG_CONFIG_HOME"] ?? home.appendingPathComponent(".config").path, isDirectory: true)
        let appConfig = appDirectory(configRoot)
        let state = environment["LLV_STATE_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? appConfig.appendingPathComponent("state", isDirectory: true)
        let installID = installID(base)
        let pointerURL = state.appendingPathComponent("self-update/release-\(installID).json")
        let cache = environment["XDG_CACHE_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? home.appendingPathComponent(".cache", isDirectory: true)
        guard let pointer = try? JSONSerialization.jsonObject(with: Data(contentsOf: pointerURL)) as? [String: Any],
              pointer["kind"] as? String == "package",
              let version = pointer["version"] as? String,
              version.range(of: "^\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.-]+)?$", options: .regularExpression) != nil,
              let sha = pointer["sha"] as? String,
              sha.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              let baseVersion = packageVersion(base), pointer["baseVersion"] as? String == baseVersion,
              let directory = pointer["dir"] as? String,
              let expectedDirectory = releaseDirectory(cache: cache, installID: installID, version: version),
              URL(fileURLWithPath: directory).standardizedFileURL == expectedDirectory,
              packageVersion(expectedDirectory) == version,
              packageName(expectedDirectory) == "delegatus-cli",
              FileManager.default.fileExists(atPath: expectedDirectory.appendingPathComponent("dist/standalone/server.js").path),
              FileManager.default.fileExists(atPath: expectedDirectory.appendingPathComponent("dist/runtime-host.mjs").path) else { return base }
        return expectedDirectory
    }

    static func installID(_ packageRoot: URL) -> String {
        SHA256.hash(data: Data(packageRoot.standardizedFileURL.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func appDirectory(_ root: URL) -> URL {
        let preferred = root.appendingPathComponent("delegatus", isDirectory: true)
        let legacy = root.appendingPathComponent("agent-log-viewer", isDirectory: true)
        if isRealDirectory(preferred) { return preferred }
        if FileManager.default.fileExists(atPath: legacy.path) { return legacy }
        return preferred
    }

    private static func releaseDirectory(cache: URL, installID: String, version: String) -> URL? {
        let appCache = appDirectory(cache)
        return appCache.appendingPathComponent("self-update/\(installID)/releases/npm-\(version)/node_modules/delegatus-cli", isDirectory: true).standardizedFileURL
    }

    private static func isRealDirectory(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return false }
        return values.isDirectory == true && values.isSymbolicLink != true
    }

    private static func packageVersion(_ root: URL) -> String? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["version"] as? String
    }

    private static func packageName(_ root: URL) -> String? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["name"] as? String
    }

    static func valid(_ install: Installation) -> Bool {
        let fm = FileManager.default
        let root = install.cli.deletingLastPathComponent().deletingLastPathComponent()
        guard fm.isExecutableFile(atPath: install.bun.path),
              fm.fileExists(atPath: install.cli.path),
              fm.fileExists(atPath: root.appendingPathComponent("dist/standalone/server.js").path),
              fm.fileExists(atPath: root.appendingPathComponent("dist/runtime-host.mjs").path),
              let bytes = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              value["name"] as? String == "delegatus-cli" else { return false }
        return true
    }

    static func discover(_ home: URL) throws -> Installation? {
        let fm = FileManager.default
        let plist = serviceFile(home)
        if fm.fileExists(atPath: plist.path) {
            let attributes = try fm.attributesOfItem(atPath: plist.path)
            let data = try Data(contentsOf: plist)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  String(data: data, encoding: .utf8)?.components(separatedBy: "\n").dropFirst(2).first == marker,
                  let object = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  object["Label"] as? String == "org.delegatus.server",
                  let args = object["ProgramArguments"] as? [String], args.count >= 2,
                  args[0].hasPrefix("/"), args[1].hasPrefix("/"),
                  args[1].hasSuffix("/bin/cli.mjs") else { throw LauncherError.message("service-invalid") }
            // A service using another port cannot be silently reused on 8898.
            if let index = args.firstIndex(of: "--port"), index + 1 < args.count, args[index + 1] != "8898" {
                throw LauncherError.message("service-port")
            }
            let install = Installation(bun: URL(fileURLWithPath: args[0]), cli: URL(fileURLWithPath: args[1]),
                environment: object["EnvironmentVariables"] as? [String: String] ?? [:], service: plist)
            guard valid(install) else { throw LauncherError.message("service-invalid") }
            return install
        }
        let root = runtime(home)
        for install in [
            Installation(bun: root.appendingPathComponent("bun/bin/bun"), cli: root.appendingPathComponent("packages/node_modules/delegatus-cli/bin/cli.mjs")),
            Installation(bun: home.appendingPathComponent(".bun/bin/bun"), cli: home.appendingPathComponent(".bun/install/global/node_modules/delegatus-cli/bin/cli.mjs"))
        ] { if valid(install) { return install } }
        return nil
    }

    static func childEnvironment(home: URL, install: Installation?, language: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = home.path
        let paths = ((try? String(contentsOfFile: "/etc/paths", encoding: .utf8)) ?? "/usr/bin\n/bin\n/usr/sbin\n/sbin").split(separator: "\n").map(String.init)
        env["PATH"] = ([install?.bun.deletingLastPathComponent().path ?? runtime(home).appendingPathComponent("bun/bin").path,
            home.appendingPathComponent(".bun/bin").path, home.appendingPathComponent(".local/bin").path,
            "/opt/homebrew/bin", "/usr/local/bin"] + paths).joined(separator: ":")
        env["LLV_LANG"] = language
        env["NO_COLOR"] = "1"
        // Captured service settings are authoritative, including state and PATH.
        for (key, value) in install?.environment ?? [:] { env[key] = value }
        return env
    }
}

enum LauncherError: Error { case message(String) }

struct Version: Comparable, Equatable {
    let numbers: [Int]
    init?(_ text: String) {
        let pieces = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".")
        guard pieces.count == 3 else { return nil }
        let values = pieces.compactMap { Int($0) }
        guard values.count == 3, values.allSatisfy({ $0 >= 0 }) else { return nil }
        numbers = values
    }
    static func < (a: Version, b: Version) -> Bool { a.numbers.lexicographicallyPrecedes(b.numbers) }
}
