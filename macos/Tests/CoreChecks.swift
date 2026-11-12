import Foundation

@main struct CoreChecks {
    static var count = 0
    static func expect(_ condition: @autoclosure () -> Bool, _ reason: String) {
        count += 1
        if !condition() { fputs("FAIL: \(reason)\n", stderr); exit(1) }
    }
    static func main() async throws {
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: home) }
        expect(Version("1.4.0")! > Version("1.3.3")!, "numeric version order")
        expect(Version("1.10.0")! > Version("1.9.9")!, "multi-digit version")
        expect(Version("bad") == nil && Version("1.2") == nil, "invalid versions")
        expect(Server.classify(status: 204, marker: "1", key: nil) == .ready(nil), "health marker")
        expect(Server.classify(status: 204, marker: nil, key: nil) == .busy, "foreign HEAD")
        expect(Server.classify(status: 200, marker: "1", key: nil) == .busy, "wrong status")
        expect(Server.classify(status: 403, marker: nil, key: nil) == .busy, "unmatched access key")
        let absent = try Installations.discover(home)
        expect(absent == nil, "fresh account needs confirmation")
        let root = Installations.runtime(home)
        let bun = root.appendingPathComponent("bun/bin/bun")
        let package = root.appendingPathComponent("packages/node_modules/delegatus-cli")
        try fm.createDirectory(at: bun.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: bun)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bun.path)
        for file in ["bin/cli.mjs", "dist/standalone/server.js", "dist/runtime-host.mjs"] {
            let destination = package.appendingPathComponent(file)
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: destination)
        }
        try Data("{\"name\":\"delegatus-cli\",\"version\":\"2.0.0\"}".utf8).write(to: package.appendingPathComponent("package.json"))
        let privateInstall = try Installations.discover(home)
        expect(privateInstall?.bun == bun, "private install with spaces")
        let service = Installations.serviceFile(home)
        try fm.createDirectory(at: service.deletingLastPathComponent(), withIntermediateDirectories: true)
        let serviceObject: [String: Any] = ["Label": "org.delegatus.server", "ProgramArguments": [bun.path, package.appendingPathComponent("bin/cli.mjs").path, "--no-open", "--port", "8898"], "EnvironmentVariables": ["LLV_STATE_DIR": home.appendingPathComponent("custom-state").path]]
        let plist = try PropertyListSerialization.data(fromPropertyList: serviceObject, format: .xml, options: 0)
        let xml = String(decoding: plist, as: UTF8.self).replacingOccurrences(of: "<plist", with: Installations.marker + "\n<plist")
        try Data(xml.utf8).write(to: service)
        let owned = try Installations.discover(home)
        expect(owned?.service == service, "owned login service wins discovery")
        expect(owned?.environment["LLV_STATE_DIR"] == home.appendingPathComponent("custom-state").path, "captured service state")
        let env = Installations.childEnvironment(home: home, install: owned, language: "uk")
        expect(env["LLV_STATE_DIR"] == owned?.environment["LLV_STATE_DIR"], "service settings reach child")
        try Data(xml.replacingOccurrences(of: Installations.marker, with: "<!-- foreign -->").utf8).write(to: service)
        do { _ = try Installations.discover(home); expect(false, "foreign service must refuse") } catch { expect(true, "foreign service refused") }
        try fm.removeItem(at: service)
        let config = home.appendingPathComponent(".config/delegatus")
        try fm.createDirectory(at: config, withIntermediateDirectories: true)
        let key = String(repeating: "a", count: 32)
        try Data((key + "\n").utf8).write(to: config.appendingPathComponent("token"))
        expect(Server.key(home: home, environment: [:]) == key, "key file resolution")
        for mode in ["open", "key", "foreign", "redirect"] {
            let child = Process(); child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            child.arguments = ["macos/Tests/ProbeServer.py"]; child.environment = ["PROBE_MODE": mode]
            let pipe = Pipe(); child.standardOutput = pipe
            try child.run()
            defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
            let data = pipe.fileHandleForReading.availableData
            let port = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let number = Int(port), (1...65535).contains(number),
                  let address = URL(string: "http://127.0.0.1:\(number)") else { fatalError("fixture port") }
            let result = await Server.probe(home: home, environment: [:], address: address)
            if mode == "key" {
                try fm.removeItem(at: config.appendingPathComponent("token"))
                let missing = await Server.probe(home: home, environment: [:], address: address)
                expect(missing == .busy, "missing key cannot reuse a protected server")
                try Data(String(repeating: "b", count: 32).utf8).write(to: config.appendingPathComponent("token"))
                let wrong = await Server.probe(home: home, environment: [:], address: address)
                expect(wrong == .busy, "wrong key cannot reuse a protected server")
                let environmentKey = await Server.probe(home: home, environment: ["LLV_TOKEN": key], address: address)
                expect(environmentKey == .ready(key), "explicit environment key has precedence")
                let alternate = home.appendingPathComponent("alternate/agent-log-viewer")
                try fm.createDirectory(at: alternate, withIntermediateDirectories: true)
                try Data(key.utf8).write(to: alternate.appendingPathComponent("token"))
                let legacy = await Server.probe(home: home, environment: ["XDG_CONFIG_HOME": alternate.deletingLastPathComponent().path], address: address)
                expect(legacy == .ready(key), "captured config root and legacy directory")
                try Data(key.utf8).write(to: config.appendingPathComponent("token"))
            }
            child.terminate(); child.waitUntilExit()
            expect(result == (mode == "open" ? .ready(nil) : mode == "key" ? .ready(key) : .busy), "real HTTP \(mode)")
            let free = await Server.probe(home: home, environment: [:], address: address)
            expect(free == .free, "closed fixture is free")
        }
        let timed = try await Server.run("/bin/sleep", ["30"], environment: [:], timeout: 0.1)
        expect(timed.0 != 0, "bounded child probe exits")
        print("Swift core checks: \(count) passed, 0 failed")
    }
}
