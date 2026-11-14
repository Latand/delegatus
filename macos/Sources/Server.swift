import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum Probe: Equatable {
    case ready(String?), free, busy, waiting
    /// A log label that never includes the access key.
    var label: String {
        switch self {
        case .ready: return "ready"
        case .free: return "free"
        case .busy: return "busy"
        case .waiting: return "waiting"
        }
    }
}

struct ListenerCheck { let owned: Bool; let verified: Bool; let description: String; let reason: String }

enum Server {
    static let address = URL(string: "http://127.0.0.1:8898")!
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
        do {
            var (data, response) = try await session.data(for: request)
            _ = data
            guard var http = response as? HTTPURLResponse else { return (.busy, "HEAD answered without HTTP") }
            var usedKey: String? = nil
            var detail = "HEAD \(http.statusCode)"
            if [401, 403].contains(http.statusCode), let key = key(home: home, environment: environment) {
                // A refusal alone does not prove that the listener is Delegatus.
                // Verify the process and its executable paths before sending a key.
                guard let install, Installations.valid(install) else { return (.busy, detail + "; key withheld: no valid installation") }
                let owner = await listener(environment: environment, install: install, port: address.port ?? 8898, launcher: launcher)
                guard owner.verified else { return (.busy, detail + "; key withheld: " + owner.reason) }
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                (data, response) = try await session.data(for: request)
                guard let retry = response as? HTTPURLResponse else { return (.busy, detail + "; keyed HEAD answered without HTTP") }
                http = retry; usedKey = key; detail += "; keyed HEAD \(retry.statusCode)"
            }
            let marker = http.value(forHTTPHeaderField: "x-delegatus-diagnostics")
            return (classify(status: http.statusCode, marker: marker, key: usedKey), detail + " marker=\(marker ?? "none")")
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
    /// belongs to this user and one of them descends, through the installed
    /// Viewer or runtime host, from this installation's CLI. `reason` names the
    /// guard that refused, for the app log.
    static func listener(environment: [String: String], install: Installation? = nil, port: Int = 8898, launcher: Int? = nil) async -> ListenerCheck {
        let started = Date()
        let result = try? await run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcu"], environment: environment)
        let elapsed = String(format: "%.1fs", Date().timeIntervalSince(started))
        guard let result else { return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof could not run") }
        let processes = listingProcesses(result.1)
        guard let first = processes.first else {
            return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof exit \(result.0) after \(elapsed) named no listener")
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
            if outcome.verified {
                return ListenerCheck(owned: true, verified: true, description: "\(entry.name) (PID \(entry.pid))", reason: outcome.reason)
            }
            refusals.append("PID \(entry.pid) \(outcome.reason)")
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
            if command.contains(bun) && (command.contains(server) || runtimeHost.map { command.contains($0) } == true) {
                foundViewer = true; roles.append("viewer")
            }
            if launcherPID == cursor || (command.contains(bun) && command.contains(cli)) { foundLauncher = true; roles.append("launcher") }
            chain.append("\(cursor)[\(roles.isEmpty ? "other" : roles.joined(separator: "+"))] \(command.prefix(240))")
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
