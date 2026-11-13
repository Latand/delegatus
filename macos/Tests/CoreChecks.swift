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
        let longCommand = String(repeating: "довгий аргумент ", count: 4000)
        let processRows = [42: "42 43 /fixture/bun /fixture/server.js \(longCommand)", 43: "43 1 /fixture/bun /fixture/cli.mjs"]
        var requested: [Int] = []
        let verified = await Server.verifyAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs") { pid in
            requested.append(pid); return processRows[pid]
        }
        expect(verified && requested == [42, 43], "long Unicode process commands retain identity and query only needed PIDs")
        let hostRows = [42: "42 43 /fixture/bun /fixture/runtime-host.mjs", 43: "43 1 /fixture/bun /fixture/cli.mjs"]
        let verifiedHost = await Server.verifyAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
            runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs") { hostRows[$0] }
        expect(verifiedHost, "runtime host stable listener follows its installed release and CLI ancestry")
        let foreignHost = [42: "42 43 /foreign/bun /fixture/runtime-host.mjs", 43: "43 1 /fixture/bun /fixture/cli.mjs"]
        let refusedHost = await Server.verifyAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
            runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs") { foreignHost[$0] }
        expect(!refusedHost, "a foreign runtime host cannot borrow the installed CLI ancestry")
        for rows in [[42: "42 1 /foreign/server"], [42: "42 43 /fixture/bun /fixture/server.js", 43: "43 42 /unrelated"], [42: "99 1 /fixture/bun /fixture/server.js /fixture/cli.mjs"], [:]] {
            let refused = await Server.verifyAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs") { rows[$0] }
            expect(!refused, "foreign, cyclic, changed and missing process identities refuse reuse")
        }
        // macOS spells one file /tmp/... and /private/tmp/...; Bun reports a
        // resolved path while the app names the path it was given.
        expect(Server.comparablePath("/private/tmp/h/bun /private/var/f/server.js") == "/tmp/h/bun /var/f/server.js", "private aliases compare as one path")
        expect(Server.comparablePath("/fixture/private/tmp/bun") == "/fixture/private/tmp/bun", "only a leading private alias is folded")
        let aliasRows = [42: "42 43 /private/tmp/h/bun --bun /private/tmp/h/server.js", 43: "43 1 /tmp/h/bun /tmp/h/cli.mjs --no-open"]
        let aliased = await Server.explainAncestry(listenerPID: 42, bun: "/tmp/h/bun", server: "/tmp/h/server.js", cli: "/private/tmp/h/cli.mjs") { aliasRows[$0] }
        expect(aliased.verified, "listener verifies across /private aliases (\(aliased.reason))")
        let renamedLauncher = [42: "42 43 /fixture/bun /fixture/server.js", 43: "43 1 node-supervisor"]
        let ownLauncher = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs", launcherPID: 43) { renamedLauncher[$0] }
        expect(ownLauncher.verified, "the CLI process this app started is the launcher by identity")
        let otherLauncher = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs", launcherPID: 77) { renamedLauncher[$0] }
        expect(!otherLauncher.verified && otherLauncher.reason.contains("no launcher"), "another process ID never stands in for the launcher (\(otherLauncher.reason))")
        for command in ["/foreign/python /fixture/bun /fixture/server.js", "/fixture/bun /fixture/server.js.foreign", "/fixture/bun /foreign.js /fixture/server.js"] {
            let rows = [42: "42 43 \(command)", 43: "43 1 /fixture/bun /fixture/cli.mjs"]
            let impostor = await Server.verifyAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs") { rows[$0] }
            expect(!impostor, "decoy argument paths cannot prove a Viewer")
        }
        let foreignViewer = [42: "42 43 /foreign/bun /fixture/server.js", 43: "43 1 /fixture/bun /fixture/cli.mjs"]
        let ownForeign = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs", launcherPID: 43) { foreignViewer[$0] }
        expect(!ownForeign.verified && ownForeign.reason.contains("no Viewer"), "the app's own launcher does not vouch for a foreign Viewer (\(ownForeign.reason))")
        let unreadable = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs") { _ in nil }
        expect(!unreadable.verified && unreadable.reason.contains("process 42 unreadable"), "an unreadable listener names its guard (\(unreadable.reason))")
        let listing = Server.listingProcesses("lsof: WARNING: can't stat() fixture\np42\ncbun\nu501\nf9\np77\ncbun\nu502\nf9\n")
        expect(listing.count == 2 && listing[0].pid == 42 && listing[0].uid == "501" && listing[1].pid == 77 && listing[1].uid == "502", "every listing process keeps its own owner")
        do {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = ["-c", "import sys; print('ready', flush=True); sys.stdin.read()", String(repeating: "x", count: 40000), "перевірка"]
            let input = Pipe(), output = Pipe(); process.standardInput = input; process.standardOutput = output
            try process.run()
            defer { try? input.fileHandleForWriting.close(); process.waitUntilExit() }
            expect(!output.fileHandleForReading.availableData.isEmpty, "owned process is ready before reading its identity")
            let row = await Server.processRow(Int(process.processIdentifier), environment: ["LC_ALL": "en_US.UTF-8"])
            expect(row?.split(whereSeparator: \.isWhitespace).first == Substring(String(process.processIdentifier)) && row!.utf8.count > 32768 && row!.contains("перевірка"), "real targeted ps preserves PID and Unicode beyond diagnostic tail limits")
        }
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
        let state = home.appendingPathComponent("custom-state")
        let releaseID = Installations.installID(package)
        // The CLI hashes the package root's real path; a home reached through a
        // symlink (as /tmp reaches /private/tmp) names the same release record.
        let alias = home.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        try fm.createSymbolicLink(at: alias, withDestinationURL: home)
        defer { try? fm.removeItem(at: alias) }
        let aliasPackage = alias.appendingPathComponent("Library/Application Support/Delegatus/Runtime/packages/node_modules/delegatus-cli")
        expect(Installations.realPath(aliasPackage) == Installations.realPath(package) && !Installations.realPath(package).contains(alias.lastPathComponent),
            "real path resolves the alias (\(Installations.realPath(aliasPackage)))")
        expect(Installations.installID(aliasPackage) == releaseID, "an aliased home keeps the CLI's install id")
        let activePackage = home.appendingPathComponent(".cache/delegatus/self-update/\(releaseID)/releases/npm-2.1.0/node_modules/delegatus-cli")
        for file in ["dist/standalone/server.js", "dist/runtime-host.mjs"] {
            let destination = activePackage.appendingPathComponent(file)
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: destination)
        }
        try Data("{\"name\":\"delegatus-cli\",\"version\":\"2.1.0\"}".utf8).write(to: activePackage.appendingPathComponent("package.json"))
        let pointer = state.appendingPathComponent("self-update/release-\(releaseID).json")
        try fm.createDirectory(at: pointer.deletingLastPathComponent(), withIntermediateDirectories: true)
        let published = ["kind": "package", "version": "2.1.0", "sha": String(repeating: "a", count: 40), "baseVersion": "2.0.0", "dir": activePackage.path]
        try JSONSerialization.data(withJSONObject: published).write(to: pointer)
        let resolvedPackage = Installations.serverPackageRoot(home: home, environment: ["LLV_STATE_DIR": state.path], install: privateInstall!)
        expect(resolvedPackage.standardizedFileURL.path == activePackage.standardizedFileURL.path, "process verification follows the validated installed release pointer (actual: \(resolvedPackage.path), expected: \(activePackage.path))")
        try Data("{\"name\":\"delegatus-cli\",\"version\":\"1.11.0\"}".utf8).write(to: package.appendingPathComponent("package.json"))
        var legacyBasePointer = published; legacyBasePointer["baseVersion"] = "1.11.0"
        try JSONSerialization.data(withJSONObject: legacyBasePointer).write(to: pointer)
        expect(Installations.legacyVersion(home: home, environment: ["LLV_STATE_DIR": state.path], install: privateInstall!) == nil, "a modern active package never inherits its legacy base CLI's root fallback")
        try JSONSerialization.data(withJSONObject: published).write(to: pointer)
        for version in ["1.11.0", "2.0.0", "1.11.0-rc.1", "invalid", "0.9.0"] {
            try Data("{\"name\":\"delegatus-cli\",\"version\":\"\(version)\"}".utf8).write(to: package.appendingPathComponent("package.json"))
            let legacy = Installations.legacyVersion(home: home, environment: [:], install: privateInstall!)
            expect(legacy == (version == "1.11.0" ? version : nil), "only a stable active v1 package enables legacy readiness")
        }
        try Data("{\"name\":\"foreign\",\"version\":\"1.11.0\"}".utf8).write(to: package.appendingPathComponent("package.json"))
        expect(Installations.legacyVersion(home: home, environment: [:], install: privateInstall!) == nil, "a version without package identity never enables fallback")
        try Data("{\"name\":\"delegatus-cli\",\"version\":\"2.0.0\"}".utf8).write(to: package.appendingPathComponent("package.json"))
        var untrustedPointer = published; untrustedPointer["dir"] = home.appendingPathComponent("foreign-package").path
        try JSONSerialization.data(withJSONObject: untrustedPointer).write(to: pointer)
        expect(Installations.serverPackageRoot(home: home, environment: ["LLV_STATE_DIR": state.path], install: privateInstall!).standardizedFileURL.path == package.standardizedFileURL.path, "release pointer cannot redirect process verification outside the private release tree")
        let service = Installations.serviceFile(home)
        try fm.createDirectory(at: service.deletingLastPathComponent(), withIntermediateDirectories: true)
        let serviceObject: [String: Any] = ["Label": "org.delegatus.server", "ProgramArguments": [bun.path, package.appendingPathComponent("bin/cli.mjs").path, "--no-open", "--port", "8898"], "EnvironmentVariables": ["LLV_STATE_DIR": home.appendingPathComponent("custom-state").path, "XDG_CONFIG_HOME": home.appendingPathComponent("custom-config").path]]
        let plist = try PropertyListSerialization.data(fromPropertyList: serviceObject, format: .xml, options: 0)
        let xml = String(decoding: plist, as: UTF8.self).replacingOccurrences(of: "<plist", with: Installations.marker + "\n<plist")
        try Data(xml.utf8).write(to: service)
        let owned = try Installations.discover(home)
        expect(owned?.service == service, "owned login service wins discovery")
        expect(owned?.environment["LLV_STATE_DIR"] == home.appendingPathComponent("custom-state").path, "captured service state")
        let direct = Installations.withoutService(owned!)
        expect(direct.service == nil && direct.bun == owned?.bun && direct.cli == owned?.cli, "login removal keeps selected installation")
        expect(direct.environment["LLV_STATE_DIR"] == owned?.environment["LLV_STATE_DIR"] && direct.environment["XDG_CONFIG_HOME"] == owned?.environment["XDG_CONFIG_HOME"], "login removal keeps state and key roots")
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
        let probeInstall = Installation(bun: bun, cli: package.appendingPathComponent("bin/cli.mjs"))
        let authMarker = home.appendingPathComponent("probe-auth-received")
        for mode in ["open", "key", "unauthorized", "foreign", "redirect", "not-found"] {
            let child = Process(); child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            child.arguments = ["macos/Tests/ProbeServer.py"]; child.environment = ["PROBE_MODE": mode, "PROBE_AUTH_FILE": authMarker.path]
            let pipe = Pipe(); child.standardOutput = pipe
            try child.run()
            defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
            let data = pipe.fileHandleForReading.availableData
            let port = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let number = Int(port), (1...65535).contains(number),
                  let address = URL(string: "http://127.0.0.1:\(number)") else { fatalError("fixture port") }
            let result = await Server.probe(home: home, environment: [:], install: probeInstall, address: address)
            if mode == "not-found" {
                expect(result == .busy && !fm.fileExists(atPath: authMarker.path), "foreign 404 receives no saved key")
            }
            if mode == "key" || mode == "unauthorized" {
                expect(result == .busy && !fm.fileExists(atPath: authMarker.path), "refusing listener receives no saved key")
                try fm.removeItem(at: config.appendingPathComponent("token"))
                let missing = await Server.probe(home: home, environment: [:], install: probeInstall, address: address)
                expect(missing == .busy, "missing key cannot reuse a protected server")
                try Data(String(repeating: "b", count: 32).utf8).write(to: config.appendingPathComponent("token"))
                let wrong = await Server.probe(home: home, environment: [:], install: probeInstall, address: address)
                expect(wrong == .busy, "wrong key cannot reuse a protected server")
                let environmentKey = await Server.probe(home: home, environment: ["LLV_TOKEN": key], install: probeInstall, address: address)
                expect(environmentKey == .busy && !fm.fileExists(atPath: authMarker.path), "unverified listener receives no environment key")
                let alternate = home.appendingPathComponent("alternate/agent-log-viewer")
                try fm.createDirectory(at: alternate, withIntermediateDirectories: true)
                try Data(key.utf8).write(to: alternate.appendingPathComponent("token"))
                let legacy = await Server.probe(home: home, environment: ["XDG_CONFIG_HOME": alternate.deletingLastPathComponent().path], install: probeInstall, address: address)
                expect(legacy == .busy && !fm.fileExists(atPath: authMarker.path), "unverified listener receives no legacy key")
                try Data(key.utf8).write(to: config.appendingPathComponent("token"))
            }
            child.terminate(); child.waitUntilExit()
            expect(result == .busy, "unverified real HTTP \(mode) refuses even a copied marker")
            let free = await Server.probe(home: home, environment: [:], install: probeInstall, address: address)
            expect(free == .free, "closed fixture is free")
        }
        func refusal(_ result: MenuWindowLookup) -> String {
            if case .refused(let reason) = result { return reason }
            return ""
        }
        let menuRows: [[String: Any]] = [
            ["kCGWindowOwnerPID": 7, "kCGWindowLayer": 0, "kCGWindowNumber": 10],
            ["kCGWindowOwnerPID": 7, "kCGWindowLayer": 24, "kCGWindowNumber": 11],
            ["kCGWindowOwnerPID": 8, "kCGWindowLayer": 101, "kCGWindowNumber": 12, "kCGWindowOwnerName": "Other"],
            ["kCGWindowOwnerPID": 7, "kCGWindowLayer": 101, "kCGWindowNumber": 13],
        ]
        expect(MenuWindowLookup.select(menuRows, ownerPID: 7, menuLevel: 101) == .found(13), "menu capture takes the owned pop-up window, never the menu bar or another process")
        let bridged: [[String: Any]] = [["kCGWindowOwnerPID": NSNumber(value: 7), "kCGWindowLayer": NSNumber(value: 101), "kCGWindowNumber": NSNumber(value: 5)]]
        expect(MenuWindowLookup.select(bridged, ownerPID: 7, menuLevel: 101) == .found(5), "window-list numbers bridge from NSNumber")
        let layerRefusal = refusal(MenuWindowLookup.select(Array(menuRows.prefix(3)), ownerPID: 7, menuLevel: 101))
        expect(layerRefusal.hasPrefix("layer:") && layerRefusal.contains("0,24") && layerRefusal.contains("Other"), "menu capture names the layer guard, the owned layers and the foreign menu window")
        let ownerRefusal = refusal(MenuWindowLookup.select([menuRows[2]], ownerPID: 7, menuLevel: 101))
        expect(ownerRefusal.hasPrefix("owner:") && ownerRefusal.contains("Other"), "a foreign menu window is refused under the owner guard")
        expect(refusal(MenuWindowLookup.select([], ownerPID: 7, menuLevel: 101)).hasPrefix("owner:"), "an empty window list refuses under the owner guard")
        let unnumbered: [[String: Any]] = [["kCGWindowOwnerPID": 7, "kCGWindowLayer": 101]]
        expect(refusal(MenuWindowLookup.select(unnumbered, ownerPID: 7, menuLevel: 101)).hasPrefix("number:"), "an owned menu window without a number refuses under the number guard")
        let timed = try await Server.run("/bin/sleep", ["30"], environment: [:], timeout: 0.1)
        expect(timed.0 != 0, "bounded child probe exits")
        print("Swift core checks: \(count) passed, 0 failed")
    }
}
