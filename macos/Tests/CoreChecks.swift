import Foundation

@main struct CoreChecks {
    static var count = 0
    static func expect(_ condition: @autoclosure () -> Bool, _ reason: String) {
        count += 1
        if !condition() { fputs("FAIL: \(reason)\n", stderr); exit(1) }
    }
    static func main() async throws {
        if await ListenerKeeper.runIfRequested() { return }
        let fm = FileManager.default
        let home = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: home) }
        // Run before the unit checks: the CLI exits while its detached server
        // stays alive. A new inspection has no launcher PID from the first run.
        try await relaunch(home)
        expect(Server.executablePath(Int(getpid())) != nil, "native process path lookup uses the SDK path bound")
        expect(Server.executablePath(-1) == nil, "native process path lookup refuses a missing PID")
        expect(Version("1.4.0")! > Version("1.3.3")!, "numeric version order")
        expect(Version("1.10.0")! > Version("1.9.9")!, "multi-digit version")
        expect(Version("bad") == nil && Version("1.2") == nil, "invalid versions")
        expect(Server.classify(status: 204, marker: "1", key: nil) == .ready(nil), "health marker")
        expect(Server.classify(status: 204, marker: nil, key: nil) == .busy, "foreign HEAD")
        expect(Server.classify(status: 200, marker: "1", key: nil) == .busy, "wrong status")
        expect(Server.classify(status: 403, marker: nil, key: nil) == .busy, "unmatched access key")
        let vanished = ListenerCheck(owned: false, verified: false, description: "?", reason: "empty lsof", absent: true)
        expect(Server.listenerDecision(vanished, recheck: .free) == .wait, "a listener that exits after HEAD keeps startup waiting")
        let hiddenRechecks: [Probe?] = [nil, .busy, .waiting, .ready(nil), .accessUnavailable("1.11.0")]
        for recheck in hiddenRechecks {
            expect(Server.listenerDecision(vanished, recheck: recheck) == .refuseOtherUser, "an unlisted listener that still answers or times out retains the other-user refusal")
        }
        let foreignOwner = ListenerCheck(owned: false, verified: false, description: "foreign", reason: "different uid")
        let unverified = ListenerCheck(owned: true, verified: false, description: "foreign", reason: "ancestry refused")
        let proven = ListenerCheck(owned: true, verified: true, description: "bun", reason: "verified")
        expect(proven.canOpen && !foreignOwner.canOpen && !unverified.canOpen, "Open existing is reserved for an owned verified installation")
        for listener in [foreignOwner, unverified] {
            expect(Server.existingKey(.ready("fixture"), listener: listener) == nil, "an untrusted manual open never gets a key")
        }
        for probe in [Probe.busy, .waiting, .free, .accessUnavailable("2.0.0"), .ready(nil)] {
            expect(Server.existingKey(probe, listener: proven) == nil, "a refused or absent key is never reused by the button")
        }
        expect(Server.existingKey(.ready("fixture"), listener: proven) == "fixture", "a freshly accepted saved key may open the verified instance")
        let namedRechecks: [Probe?] = [nil, .free, .busy, .waiting]
        for recheck in namedRechecks {
            expect(Server.listenerDecision(foreignOwner, recheck: recheck) == .refuseOtherUser, "a named foreign owner always retains its refusal")
            expect(Server.listenerDecision(unverified, recheck: recheck) == .refuseOwner, "a named unverified listener always retains owner guidance")
            expect(Server.listenerDecision(proven, recheck: recheck) == .wait, "a verified booting listener retains its readiness wait")
        }
        let unreadableListener = ListenerCheck(owned: false, verified: false, description: "?", reason: "lsof could not run")
        expect(Server.listenerDecision(unreadableListener, recheck: .free) == .refuseOtherUser, "failure to run lsof does not prove an absent listener")
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
        for script in ["/fixture/server.js", "/fixture/runtime-host.mjs"] {
            let orphan = [42: "42 1 /fixture/bun \(script)"]
            let detached = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
                runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs", recorded: true, readExecutable: { _ in "/fixture/bun" }) { orphan[$0] }
            expect(detached.verified, "kernel-proven installed orphan survives the CLI: \(detached.reason)")
            let unrecorded = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
                runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs", readExecutable: { _ in "/fixture/bun" }) { orphan[$0] }
            expect(!unrecorded.verified && unrecorded.reason.contains("no launcher"), "a same-Bun copied title without a recorded birth identity receives no trust")
            let executables: [String?] = [nil, "/foreign/bun", "/fixture/bun-similar"]
            for executable in executables {
                let decoy = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
                    runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs", readExecutable: { _ in executable }) { orphan[$0] }
                expect(!decoy.verified && decoy.reason.contains("executable"), "a copied title or unreadable executable never proves an orphan")
            }
        }
        for command in ["/foreign/python /fixture/bun /fixture/server.js", "/fixture/bun /fixture/server.js.foreign", "/fixture/bun /foreign.js /fixture/server.js"] {
            let decoy = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
                cli: "/fixture/cli.mjs", readExecutable: { _ in "/fixture/bun" }) { _ in "42 1 \(command)" }
            expect(!decoy.verified, "even a kernel-proven Bun cannot borrow a Viewer argument path")
        }
        var identityReads = 0
        let changedExecutable = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
            cli: "/fixture/cli.mjs", readExecutable: { _ in "/fixture/bun" }) { _ in
            identityReads += 1
            return identityReads == 1 ? "42 1 /fixture/bun /fixture/server.js" : "42 1 /foreign/server"
        }
        expect(!changedExecutable.verified && changedExecutable.reason.contains("changed during"), "a changed identity after the executable await refuses reuse")
        for listener in ["/foreign/python /foreign/http.py", "/fixture/python /foreign/http.py"] {
            let borrowed = [42: "42 43 \(listener)", 43: "43 44 /fixture/bun /fixture/runtime-host.mjs", 44: "44 1 /fixture/bun /fixture/cli.mjs"]
            let result = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js",
                runtimeHost: "/fixture/runtime-host.mjs", cli: "/fixture/cli.mjs") { borrowed[$0] }
            expect(!result.verified && result.reason.contains("listener PID does not run"), "foreign HTTP listener cannot inherit Viewer/runtime-host ancestry")
        }
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
        expect(!ownForeign.verified && ownForeign.reason.contains("listener PID does not run"), "the app's own launcher does not vouch for a foreign Viewer (\(ownForeign.reason))")
        let unreadable = await Server.explainAncestry(listenerPID: 42, bun: "/fixture/bun", server: "/fixture/server.js", cli: "/fixture/cli.mjs") { _ in nil }
        expect(!unreadable.verified && unreadable.reason.contains("process 42 unreadable"), "an unreadable listener names its guard (\(unreadable.reason))")
        let listing = Server.listingProcesses("lsof: WARNING: can't stat() fixture\np42\ncbun\nu501\nf9\np77\ncbun\nu502\nf9\n")
        expect(listing.count == 2 && listing[0].pid == 42 && listing[0].uid == "501" && listing[1].pid == 77 && listing[1].uid == "502", "every listing process keeps its own owner")
        let otherUID = String(getuid() + 1)
        for output in ["p42\ncbun\nu\(otherUID)\n", "p42\ncbun\nu\(getuid())\np77\ncbun\nu\(otherUID)\n", "p42\ncbun\n"] {
            let refused = await Server.listener(environment: [:], readListing: { (0, output) })
            expect(!refused.owned && !refused.verified && !refused.canOpen && refused.reason.contains("owner is not uid"), "another or missing uid refuses before installation checks and never offers Open existing")
        }
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

    static func relaunch(_ home: URL) async throws {
        let fm = FileManager.default
        // Throw here so a failing lifecycle assertion still tears down its
        // recorded children before the test executable exits.
        func check(_ condition: Bool, _ reason: String) throws {
            count += 1
            if !condition { throw LauncherError.message(reason) }
        }
        let located = try await Server.run("/usr/bin/which", ["bun"], environment: ProcessInfo.processInfo.environment)
        let source = located.1.trimmingCharacters(in: .whitespacesAndNewlines)
        try check(located.0 == 0 && fm.isExecutableFile(atPath: source), "relaunch fixture needs the CI Bun")
        let root = home.appendingPathComponent("relaunch")
        let bun = root.appendingPathComponent("bun")
        let cli = root.appendingPathComponent("bin/cli.mjs")
        let server = root.appendingPathComponent("dist/standalone/server.js")
        for file in [cli, server, root.appendingPathComponent("dist/runtime-host.mjs")] {
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: file)
        }
        try fm.copyItem(at: URL(fileURLWithPath: Installations.realPath(URL(fileURLWithPath: source))), to: bun)
        try Data(#"{"name":"delegatus-cli","version":"2.0.0"}"#.utf8).write(to: root.appendingPathComponent("package.json"))
        try Data(#"""
        import {existsSync,readFileSync,writeFileSync} from 'node:fs';
        import {join} from 'node:path';
        const phase=join(import.meta.dir,'../../phase'), auth=join(import.meta.dir,'../../auth');
        const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
          const diagnostics = new URL(request.url).pathname !== '/';
          const mode=existsSync(phase)?readFileSync(phase,'utf8'):'open';
          if(request.headers.has('Authorization')) writeFileSync(auth,'received');
          if(mode==='key' && request.headers.get('Authorization')!=='Bearer '+'a'.repeat(32)) return new Response(null,{status:403});
          if(mode==='not-found' && diagnostics) return new Response(null,{status:404});
          return new Response(null, {status:diagnostics?204:200,headers:diagnostics?{'x-delegatus-diagnostics':'1'}:{}});
        }});
        console.log(JSON.stringify({pid:process.pid,port:server.port}));
        """#.utf8).write(to: server)
        try Data(#"""
        import {spawn} from 'node:child_process';
        const child=spawn(process.execPath,[process.argv[1].replace('bin/cli.mjs','dist/standalone/server.js')],{detached:true,stdio:['ignore','inherit','inherit']});
        process.stdin.resume();
        """#.utf8).write(to: cli)
        let env = ["HOME": home.path, "XDG_CONFIG_HOME": root.appendingPathComponent("config").path,
            "LLV_STATE_DIR": root.appendingPathComponent("state").path, "TMPDIR": fm.temporaryDirectory.path]
        let launcher = Process(); launcher.executableURL = bun; launcher.arguments = [cli.path]; launcher.environment = env
        let input = Pipe(), output = Pipe(); launcher.standardInput = input; launcher.standardOutput = output
        try launcher.run()
        defer { if launcher.isRunning { launcher.terminate(); launcher.waitUntilExit() } }
        let handshake = try JSONSerialization.jsonObject(with: output.fileHandleForReading.availableData) as! [String: Int]
        let pid = handshake["pid"]!, port = handshake["port"]!
        var serverAlive = true
        defer { if serverAlive { kill(Int32(pid), SIGTERM) } }
        let install = Installation(bun: bun, cli: cli)
        let first = await Server.listener(environment: env, install: install, port: port, launcher: Int(launcher.processIdentifier))
        try check(first.verified, "the initial launcher verifies its own server: \(first.reason)")
        let identities = await ListenerKeeper.read(home: home, port: port, identities: first.identities)
        let keeperPID = await ListenerKeeper.pid(home: home, port: port, identities: first.identities)
        try check(keeperPID != nil && identities.count == 1 && identities.first == Server.listenerIdentity(pid, install: install, package: root), "the real keeper's retained generation round-trips through the authenticated reader")
        let retained = identities[0]
        let stale = ListenerIdentity(pid: retained.pid, uid: retained.uid, birth: "stale", bun: retained.bun, cli: retained.cli, package: retained.package)
        try check((await ListenerKeeper.read(home: home, port: port, identities: [stale])).isEmpty, "a different process generation cannot inherit the keeper endpoint")
        launcher.terminate(); launcher.waitUntilExit()
        // Without the kernel identity, this is the original CLI-ancestor
        // guard, driven by the real surviving process rather than canned rows.
        let prior = await Server.explainAncestry(listenerPID: pid, bun: bun.path, server: server.path, cli: cli.path) {
            await Server.processRow($0, environment: env)
        }
        print("RELAUNCH prior guard: \(prior.reason.replacingOccurrences(of: home.path, with: "$CHECK_HOME"))")
        try check(!prior.verified && prior.reason.contains("no launcher"), "reproduce the original refusal after the CLI exits")
        let config = root.appendingPathComponent("config/delegatus")
        try fm.createDirectory(at: config, withIntermediateDirectories: true)
        let key = String(repeating: "a", count: 32)
        try Data(key.utf8).write(to: config.appendingPathComponent("token"))
        let phase = root.appendingPathComponent("phase"), auth = root.appendingPathComponent("auth")
        try Data("key".utf8).write(to: phase)
        try Data("open".utf8).write(to: phase)
        try fm.removeItem(at: config.appendingPathComponent("token"))
        let later = await Server.listener(environment: env, install: install, port: port)
        print("RELAUNCH listener: \(later.reason.replacingOccurrences(of: home.path, with: "$CHECK_HOME"))")
        try check(later.verified, "relaunch must retain its installed server after the CLI exits: \(later.reason)")
        let address = URL(string: "http://127.0.0.1:\(port)")!
        let probe = await Server.inspect(home: home, environment: env, install: install, address: address)
        try check(probe.probe == .ready(nil) && kill(Int32(pid), 0) == 0, "relaunch reuses the same live server: \(probe.detail)")
        for version in ["1.11.0", "2.0.0", "99.0.0"] {
            try Data("{\"name\":\"delegatus-cli\",\"version\":\"\(version)\"}".utf8).write(to: root.appendingPathComponent("package.json"))
            let result = await Server.probe(home: home, environment: env, install: install, address: address)
            try check(result == .ready(nil) && kill(Int32(pid), 0) == 0, "both older and newer installed versions reuse the surviving server")
        }
        try Data("key".utf8).write(to: phase)
        let missing = await Server.probe(home: home, environment: env, install: install, address: address)
        try check(missing == .accessUnavailable("99.0.0") && Server.existingKey(missing, listener: later) == nil, "a missing saved key offers manual entry without credentials")
        try Data(key.utf8).write(to: config.appendingPathComponent("token"))
        let keyed = await Server.probe(home: home, environment: env, install: install, address: address)
        try check(keyed == .ready(key) && fm.fileExists(atPath: root.appendingPathComponent("auth").path), "orphan accepts this account's saved key before keyed readiness")
        try Data(String(repeating: "b", count: 32).utf8).write(to: config.appendingPathComponent("token"))
        let refused = await Server.probe(home: home, environment: env, install: install, address: address)
        try check(refused == .accessUnavailable("99.0.0") && Server.existingKey(refused, listener: later) == nil, "a wrong saved key never reaches the manual page")
        try Data("not-found".utf8).write(to: phase)
        let pending = await Server.probe(home: home, environment: env, install: install, address: address)
        try check(pending == .busy && later.canOpen && Server.existingKey(pending, listener: later) == nil, "modern 404 keeps automatic attach refused and allows a keyless manual page")
        // A different script under exactly the same Bun supplies every public
        // field of the old receipt and copies the installed Viewer's ps title.
        let foreign = root.appendingPathComponent("foreign.mjs")
        let title = try JSONSerialization.data(withJSONObject: ["\(bun.path) \(server.path)"])
        let titleJSON = String(decoding: title, as: UTF8.self).dropFirst().dropLast()
        try Data("""
        import {writeFileSync} from 'node:fs';
        process.title=\(titleJSON);
        const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
          if(request.headers.has('authorization') || request.headers.has('cookie') || new URL(request.url).searchParams.has('k')) writeFileSync('\(auth.path)','received');
          return new Response(null,{status:request.headers.has('authorization')?204:403,headers:{'x-delegatus-diagnostics':'1'}});
        }});
        console.log(JSON.stringify({port:server.port}));
        """.utf8).write(to: foreign)
        // Before the app has opened, a fake CLI starts a detached fake Viewer
        // and the genuine native keeper. Both scripts use the installed Bun
        // and copy the installed entry points in their process titles.
        do {
            let fakeParent = root.appendingPathComponent("fake-parent.mjs")
            let exited = root.appendingPathComponent("foreign-bootstrap-exited")
            let parameters = String(decoding: try JSONEncoder().encode([
                bun.path, cli.path, foreign.path, ListenerKeeper.executable, ListenerKeeper.option, exited.path
            ]), as: UTF8.self)
            try Data("""
            import {spawn} from 'node:child_process';
            import {once} from 'node:events';
            import {writeFileSync} from 'node:fs';
            const [bun,cli,foreign,native,option,exited]=\(parameters);
            process.title=bun+' '+cli;
            const child=spawn(bun,[foreign,'x'.repeat(4096)],{detached:true,stdio:['ignore','pipe','inherit']});
            const [data]=await once(child.stdout,'data');
            const {port}=JSON.parse(data.toString());
            const keeper=spawn(native,[option,bun,cli,String(port),'0'],{stdio:'ignore'});
            keeper.once('exit',code=>writeFileSync(exited,String(code)));
            console.log(JSON.stringify({pid:child.pid,port,keeper:keeper.pid}));
            process.stdin.resume();
            """.utf8).write(to: fakeParent)
            let parent = Process(); parent.executableURL = bun
            parent.arguments = [fakeParent.path, String(repeating: "x", count: 4096)]; parent.environment = env
            let parentOutput = Pipe(), parentInput = Pipe()
            parent.standardOutput = parentOutput; parent.standardInput = parentInput
            try parent.run()
            defer { if parent.isRunning { parent.terminate(); parent.waitUntilExit() } }
            let attack = try JSONSerialization.jsonObject(with: parentOutput.fileHandleForReading.availableData) as! [String: Int]
            let attackPID = attack["pid"]!, attackPort = attack["port"]!, helperPID = attack["keeper"]!
            defer {
                kill(Int32(attackPID), SIGTERM)
                if Server.executablePath(helperPID) == ListenerKeeper.executable { kill(Int32(helperPID), SIGTERM) }
            }
            let identity = Server.listenerIdentity(attackPID, install: install, package: root)!
            let copied = await Server.listener(environment: env, install: install, port: attackPort, retaining: false)
            try check(copied.verified, "hostile fixture reaches the copied live CLI ancestry guard")
            let deadline = Date().addingTimeInterval(30)
            var proof: [ListenerIdentity] = []
            while Date() < deadline {
                proof = await ListenerKeeper.read(home: home, port: attackPort, identities: [identity])
                if !proof.isEmpty || fm.fileExists(atPath: exited.path) { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            let status = try? String(contentsOf: exited, encoding: .utf8)
            try check(proof.isEmpty && status == "0", "a foreign CLI parent cannot bootstrap the genuine native keeper")
            parent.terminate(); parent.waitUntilExit()
            try? fm.removeItem(at: auth)
            let refused = await Server.listener(environment: env, install: install, port: attackPort)
            let probe = await Server.inspect(home: home, environment: env, install: install,
                address: URL(string: "http://127.0.0.1:\(attackPort)")!)
            try check(!refused.verified && !refused.canOpen && refused.reason.contains("no launcher"), "first app open refuses the orphan from the copied CLI")
            try check(probe.probe == .busy && !fm.fileExists(atPath: auth.path)
                && Server.existingKey(probe.probe, listener: refused) == nil, "foreign bootstrap grants no Authorization, cookie, query key or keyed page")
        }
        let decoy = Process(); decoy.executableURL = bun; decoy.arguments = [foreign.path, String(repeating: "x", count: 4096)]; decoy.environment = env
        let decoyOutput = Pipe(); decoy.standardOutput = decoyOutput
        try decoy.run()
        defer { if decoy.isRunning { decoy.terminate(); decoy.waitUntilExit() } }
        let decoyHandshake = try JSONSerialization.jsonObject(with: decoyOutput.fileHandleForReading.availableData) as! [String: Int]
        let decoyPort = decoyHandshake["port"]!
        let forged = Server.listenerIdentity(Int(decoy.processIdentifier), install: install, package: root)!
        let receipt = home.appendingPathComponent("Library/Application Support/Delegatus/Listeners/\(decoyPort).json")
        try fm.createDirectory(at: receipt.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode([forged]).write(to: receipt)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receipt.path)
        // Even a live Unix endpoint supplying a valid identity array is refused
        // when the kernel identifies its peer as Bun instead of this native app.
        let fakeSocket = ListenerKeeper.socketPath(home: home, port: decoyPort, identities: [forged])
        let fakeSource = root.appendingPathComponent("fake-keeper.mjs")
        let socketJSON = String(decoding: try JSONEncoder().encode(fakeSocket), as: UTF8.self)
        let receiptJSON = String(decoding: try JSONEncoder().encode(receipt.path), as: UTF8.self)
        try Data("import {createServer} from 'node:net'; import {readFileSync} from 'node:fs'; createServer(socket=>{socket.on('error',()=>{});socket.end(readFileSync(\(receiptJSON)));}).listen(\(socketJSON),()=>console.log('ready'));".utf8).write(to: fakeSource)
        let fake = Process(); fake.executableURL = bun; fake.arguments = [fakeSource.path]; fake.environment = env
        let fakeOutput = Pipe(); fake.standardOutput = fakeOutput
        try fake.run()
        defer { if fake.isRunning { fake.terminate(); fake.waitUntilExit() } }
        try check(!fakeOutput.fileHandleForReading.availableData.isEmpty, "foreign keeper endpoint is listening")
        try? fm.removeItem(at: auth)
        let forgedProbe = await Server.inspect(home: home, environment: env, install: install, address: URL(string: "http://127.0.0.1:\(decoyPort)")!)
        let forgedOwner = await Server.listener(environment: env, install: install, port: decoyPort)
        try check(forgedProbe.probe == .busy && !forgedOwner.canOpen && !fm.fileExists(atPath: auth.path), "forged current birth receipt grants neither a button nor credentials: \(forgedProbe.detail)")
        try check((await ListenerKeeper.read(home: home, port: decoyPort, identities: [forged])).isEmpty, "an unverified listener cannot bootstrap a native keeper")
        let attempted = await ListenerKeeper.start(home: home, port: decoyPort, identities: [forged], install: install, launcher: nil, environment: env)
        try check(!attempted && decoy.isRunning, "a directly launched keeper independently refuses the copied title")
        try fm.removeItem(at: root.appendingPathComponent("dist/runtime-host.mjs"))
        let incomplete = await Server.listener(environment: env, install: install, port: port)
        try check(!incomplete.verified && !incomplete.canOpen && incomplete.reason == "installation is incomplete", "package integrity still fences orphan reuse and the button")
        kill(Int32(pid), SIGTERM)
        serverAlive = false
        let cleanupDeadline = Date().addingTimeInterval(5)
        while let keeperPID, kill(keeperPID, 0) == 0, Date() < cleanupDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
        try check(keeperPID.map { kill($0, 0) != 0 } == true, "the native keeper exits after its retained server generation exits")
    }
}
