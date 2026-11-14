import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum Probe: Equatable {
    case ready(String?), accessUnavailable(String), free, busy, waiting
    /// A log label that never includes the access key.
    var label: String {
        switch self {
        case .ready: return "ready"
        case .accessUnavailable: return "access-unavailable"
        case .free: return "free"
        case .busy: return "busy"
        case .waiting: return "waiting"
        }
    }
}

struct ListenerCheck {
    let owned: Bool; let verified: Bool; let description: String; let reason: String
    var absent = false
}

enum ListenerDecision: Equatable { case wait, refuseOwner, refuseOtherUser }

enum Server {
    static let address = URL(string: "http://127.0.0.1:8898")!
    /// An empty lsof result can mean either an exited process or a listener
    /// hidden from this user. Only a fresh connection refusal proves it free.
    static func listenerDecision(_ listener: ListenerCheck, recheck: Probe? = nil) -> ListenerDecision {
        if listener.verified || (listener.absent && recheck == .free) { return .wait }
        return listener.owned ? .refuseOwner : .refuseOtherUser
    }
    static func classify(status: Int, marker: String?, key: String?) -> Probe {
        status == 204 && marker == "1" ? .ready(key) : .busy
    }
    static func key(home: URL, environment: [String: String]) -> String? {
        if let key = environment["LLV_TOKEN"], !key.isEmpty { return key }
        let config = environment["XDG_CONFIG_HOME"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".config")
        let current = config.appendingPathComponent("delegatus")
        let directory = FileManager.default.fileExists(atPath: current.path) ? current : config.appendingPathComponent("agent-log-viewer")
        guard let key = try? String(contentsOf: directory.appendingPathComponent("token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              key.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }
        return key
    }
    static func probe(home: URL, environment: [String: String], install: Installation? = nil, address: URL = address, launcher: Int? = nil) async -> Probe {
        await inspect(home: home, environment: environment, install: install, address: address, launcher: launcher).probe
    }
    /// The probe result with the observation that decided it, for the app log.
    static func inspect(home: URL, environment: [String: String], install: Installation? = nil, address: URL = address, launcher: Int? = nil) async -> (probe: Probe, detail: String) {
        // Ephemeral session, no proxy, redirects, credentials or cookies.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: address.appendingPathComponent("api/onboarding/diagnostics"))
        request.httpMethod = "HEAD"
        request.timeoutInterval = 2
        let version = install.flatMap { Installations.servingVersion(home: home, environment: environment, install: $0) } ?? ""
        let packageRoot = install.map { Installations.serverPackageRoot(home: home, environment: environment, install: $0) }
        let legacy = install.flatMap { Installations.legacyVersion(home: home, environment: environment, install: $0) }
        // Bind the whole observation to the selected serving package. A release
        // switch during an await must not inherit the old version's fallback.
        func samePackage(_ install: Installation) -> Bool {
            Installations.serverPackageRoot(home: home, environment: environment, install: install) == packageRoot
                && (Installations.servingVersion(home: home, environment: environment, install: install) ?? "") == version
        }
        // Ownership is freshly checked before every credential-bearing request
        // and before accepting either readiness protocol (including monitoring).
        func verified() async -> Bool {
            guard let install, Installations.valid(install), samePackage(install) else { return false }
            let owner = await listener(environment: environment, install: install, port: address.port ?? 8898, launcher: launcher)
            return !Task.isCancelled && owner.verified && samePackage(install)
        }
        do {
            let (_, response) = try await session.data(for: request)
            guard var http = response as? HTTPURLResponse else { return (.busy, "HEAD answered without HTTP") }
            var usedKey: String? = nil
            var detail = "HEAD \(http.statusCode)"
            if [401, 403].contains(http.statusCode) {
                guard await verified() else { return (.busy, detail + "; key withheld: listener unverified") }
                guard let key = key(home: home, environment: environment) else { return (.accessUnavailable(version), detail + "; saved key unavailable") }
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                let (_, retry) = try await session.data(for: request)
                guard let retry = retry as? HTTPURLResponse else { return (.busy, detail + "; keyed HEAD answered without HTTP") }
                http = retry; usedKey = key; detail += "; keyed HEAD \(retry.statusCode)"
                if [401, 403].contains(http.statusCode) {
                    guard await verified() else { return (.busy, detail + "; listener changed") }
                    return (.accessUnavailable(version), detail + "; saved key refused")
                }
            }
            let marker = http.value(forHTTPHeaderField: "x-delegatus-diagnostics")
            detail += " marker=\(marker ?? "none")"
            if classify(status: http.statusCode, marker: marker, key: usedKey) == .ready(usedKey) {
                guard await verified() else { return (.busy, detail + "; listener unverified") }
                return (.ready(usedKey), detail)
            }
            guard http.statusCode == 404, let legacy, await verified() else { return (.busy, detail) }
            // A bare root 200 is meaningful only for the proven active v1
            // package. Modern boot-time 404s keep the original readiness wait.
            request.url = address
            var (_, rootResponse) = try await session.data(for: request)
            guard var root = rootResponse as? HTTPURLResponse else { return (.busy, detail + "; root answered without HTTP") }
            if [401, 403].contains(root.statusCode), usedKey == nil {
                guard await verified() else { return (.busy, detail + "; root key withheld: listener changed") }
                guard let key = key(home: home, environment: environment) else { return (.accessUnavailable(legacy), detail + "; root needs saved key") }
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                (_, rootResponse) = try await session.data(for: request)
                guard let retry = rootResponse as? HTTPURLResponse else { return (.busy, detail + "; keyed root answered without HTTP") }
                root = retry; usedKey = key
            }
            guard await verified() else { return (.busy, detail + "; root listener changed") }
            detail += "; verified Delegatus \(legacy) root HEAD \(root.statusCode)"
            if [401, 403].contains(root.statusCode) { return (.accessUnavailable(legacy), detail) }
            return (root.statusCode == 200 ? .ready(usedKey) : .busy, detail)
        } catch let error as URLError {
            return (error.code == .cannotConnectToHost ? .free : .waiting, "URLError \(error.code.rawValue)")
        } catch { return (.waiting, "request error \(type(of: error))") }
    }
    static func run(_ executable: String, _ arguments: [String], environment: [String: String], output: FileHandle? = nil, timeout: Double = 15, outputLimit: Int? = 32768) async throws -> (Int32, String) {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments; process.environment = environment
                // File output avoids a full pipe deadlocking a child.
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                FileManager.default.createFile(atPath: temporary.path, contents: nil)
                do {
                    let handle = try FileHandle(forWritingTo: temporary)
                    defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
                    process.standardOutput = output ?? handle; process.standardError = output ?? handle
                    let finished = DispatchSemaphore(value: 0)
                    process.terminationHandler = { _ in finished.signal() }
                    try process.run()
                    if finished.wait(timeout: .now() + timeout) == .timedOut {
                        process.terminate()
                        if finished.wait(timeout: .now() + 3) == .timedOut { kill(process.processIdentifier, SIGKILL) }
                    }
                    process.waitUntilExit()
                    let bytes = (try? Data(contentsOf: temporary)) ?? Data()
                    continuation.resume(returning: (process.terminationStatus, String(decoding: outputLimit.map { Data(bytes.suffix($0)) } ?? bytes, as: UTF8.self)))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    /// Identifies who holds the port. `verified` means every listing process
    /// belongs to this user and each descends, through the installed
    /// Viewer or runtime host, from this installation's CLI. `reason` names the
    /// guard that refused, for the app log.
    static func listener(environment: [String: String], install: Installation? = nil, port: Int = 8898, launcher: Int? = nil) async -> ListenerCheck {
        let started = Date()
        let result = try? await run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcu"], environment: environment)
        let elapsed = String(format: "%.1fs", Date().timeIntervalSince(started))
        guard let result else { return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof could not run") }
        let processes = listingProcesses(result.1)
        guard let first = processes.first else {
            return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof exit \(result.0) after \(elapsed) named no listener", absent: true)
        }
        let description = "\(first.name) (PID \(first.pid))"
        let uid = String(getuid())
        guard processes.allSatisfy({ $0.uid == uid }) else {
            let owners = processes.map { "PID \($0.pid) uid \($0.uid)" }.joined(separator: ", ")
            return ListenerCheck(owned: false, verified: false, description: description, reason: "listener owner is not uid \(uid): \(owners)")
        }
        guard let install else { return ListenerCheck(owned: true, verified: false, description: description, reason: "no installation to verify against") }
        guard Installations.valid(install) else { return ListenerCheck(owned: true, verified: false, description: description, reason: "installation is incomplete") }
        // The CLI owns a child Viewer process. Verify that listener's executable
        // (or the runtime host's stable listener) and its ancestry back to this
        // installation before reusing it or sending a key.
        let packageRoot = Installations.serverPackageRoot(home: URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory()), environment: environment, install: install)
        let server = packageRoot.appendingPathComponent("dist/standalone/server.js").path
        let runtimeHost = packageRoot.appendingPathComponent("dist/runtime-host.mjs").path
        var refusals: [String] = []
        for entry in processes {
            let outcome = await explainAncestry(listenerPID: entry.pid, bun: install.bun.path, server: server, runtimeHost: runtimeHost,
                cli: install.cli.path, launcherPID: launcher) { pid in
                await processRow(pid, environment: environment)
            }
            if !outcome.verified { refusals.append("PID \(entry.pid) \(outcome.reason)") }
        }
        if refusals.isEmpty {
            return ListenerCheck(owned: true, verified: true, description: description, reason: "all listeners have verified installation ancestry")
        }
        return ListenerCheck(owned: true, verified: false, description: description,
            reason: "ancestry unverified (expected bun \(install.bun.path), Viewer \(server) or \(runtimeHost), CLI \(install.cli.path)): " + refusals.joined(separator: "; "))
    }
    /// Groups `lsof -F pcu` output by process. Warnings and file rows are ignored.
    static func listingProcesses(_ output: String) -> [(pid: Int, name: String, uid: String)] {
        var processes: [(pid: Int, name: String, uid: String)] = []
        for line in output.split(separator: "\n").map(String.init) {
            if line.hasPrefix("p"), let pid = Int(line.dropFirst()) { processes.append((pid: pid, name: "?", uid: "?")) }
            else if line.hasPrefix("c"), !processes.isEmpty { processes[processes.count - 1].name = String(line.dropFirst()) }
            else if line.hasPrefix("u"), !processes.isEmpty { processes[processes.count - 1].uid = String(line.dropFirst()) }
        }
        return processes
    }
    /// macOS names the same file as /tmp/... and /private/tmp/... (also /var
    /// and /etc). Compare paths and process commands in one spelling.
    static func comparablePath(_ text: String) -> String {
        text.replacingOccurrences(of: "(^|\\s)/private/(tmp|var|etc)/", with: "$1/$2/", options: .regularExpression)
    }
    /// Match an executable and its entry point, never paths supplied as
    /// unrelated arguments or suffixes of another executable/script.
    static func runs(_ command: String, bun: String, script: String) -> Bool {
        ["\(bun) \(script)", "\(bun) --bun \(script)"].contains { prefix in
            command == prefix || command.hasPrefix(prefix + " ")
        }
    }
    static func processRow(_ pid: Int, environment: [String: String]) async -> String? {
        let row = try? await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "pid=,ppid=,command="],
            environment: environment, timeout: 2, outputLimit: nil)
        return row?.0 == 0 ? row?.1 : nil
    }
    static func verifyAncestry(listenerPID: Int, bun: String, server: String, runtimeHost: String? = nil, cli: String, launcherPID: Int? = nil,
        readProcess: (Int) async -> String?) async -> Bool {
        await explainAncestry(listenerPID: listenerPID, bun: bun, server: server, runtimeHost: runtimeHost, cli: cli, launcherPID: launcherPID, readProcess: readProcess).verified
    }
    /// Walks from the listener to its ancestors. The Viewer is a process running
    /// the installed Bun on the installed server or runtime host; the launcher is
    /// a process running the installed Bun on the installed CLI, or the CLI
    /// process this app started itself (`launcherPID`). Both must be found.
    static func explainAncestry(listenerPID: Int, bun: String, server: String, runtimeHost: String? = nil, cli: String, launcherPID: Int? = nil,
        readProcess: (Int) async -> String?) async -> (verified: Bool, reason: String) {
        let bun = comparablePath(bun), server = comparablePath(server), cli = comparablePath(cli)
        let runtimeHost = runtimeHost.map(comparablePath)
        var cursor = listenerPID
        var visited = Set<Int>()
        var chain: [String] = []
        var foundViewer = false
        var listenerRunsViewer = false
        var foundLauncher = false
        let deadline = Date().addingTimeInterval(10)
        func walked() -> String { chain.isEmpty ? "nothing" : chain.joined(separator: " <- ") }
        // Query only this listener and its parents. Diagnostic tail limits must
        // never discard process identity, even for a long Unicode command.
        while cursor > 1, visited.count < 64, visited.insert(cursor).inserted {
            guard Date() < deadline else { return (false, "deadline after \(walked())") }
            guard let row = await readProcess(cursor) else { return (false, "process \(cursor) unreadable after \(walked())") }
            guard Date() < deadline else { return (false, "deadline after \(walked())") }
            let fields = row.split(maxSplits: 2, whereSeparator: \.isWhitespace)
            guard fields.count == 3, Int(fields[0]) == cursor, let parent = Int(fields[1]) else {
                return (false, "process \(cursor) row malformed or changed after \(walked())")
            }
            let command = comparablePath(String(fields[2]).trimmingCharacters(in: .whitespacesAndNewlines))
            var roles: [String] = []
            if runs(command, bun: bun, script: server) || runtimeHost.map({ runs(command, bun: bun, script: $0) }) == true {
                foundViewer = true
                if cursor == listenerPID { listenerRunsViewer = true }
                roles.append("viewer")
            }
            if launcherPID == cursor || runs(command, bun: bun, script: cli) { foundLauncher = true; roles.append("launcher") }
            chain.append("\(cursor)[\(roles.isEmpty ? "other" : roles.joined(separator: "+"))] \(command.prefix(240))")
            if !listenerRunsViewer { return (false, "listener PID does not run the installed Viewer or runtime host: \(walked())") }
            if foundViewer && foundLauncher { return (true, "verified \(walked())") }
            cursor = parent
        }
        return (false, "\(foundViewer ? "" : "no Viewer")\(!foundViewer && !foundLauncher ? ", " : "")\(foundLauncher ? "" : "no launcher") in \(walked())")
    }
    static func startService(_ plist: URL, environment: [String: String]) async throws {
        let target = "gui/\(getuid())/org.delegatus.server"
        let loaded = try await run("/bin/launchctl", ["print", target], environment: environment)
        let result = try await run("/bin/launchctl", loaded.0 == 0 ? ["kickstart", target] : ["bootstrap", "gui/\(getuid())", plist.path], environment: environment)
        guard result.0 == 0 else { throw LauncherError.message("service-failed") }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
