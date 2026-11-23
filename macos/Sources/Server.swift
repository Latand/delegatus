import Foundation
#if os(macOS)
import Darwin
#endif
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
    var identities: [ListenerIdentity] = []
    var canOpen: Bool { owned && verified }
}

enum ListenerDecision: Equatable { case wait, refuseOwner, refuseOtherUser }

struct ListenerIdentity: Codable, Equatable {
    let pid: Int; let uid: UInt32; let birth: String
    let bun: String; let cli: String; let package: String
}

enum Server {
    static let address = URL(string: "http://127.0.0.1:8898")!
    static func existingKey(_ probe: Probe, listener: ListenerCheck) -> String? {
        guard listener.canOpen, case .ready(let key) = probe else { return nil }
        return key
    }
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
    /// belongs to this user and runs the installed Viewer/runtime host under
    /// the kernel-proven installed Bun, with CLI ancestry or a walk to launchd.
    static func listener(environment: [String: String], install: Installation? = nil, port: Int = 8898, launcher: Int? = nil,
        readListing: (() async -> (Int32, String)?)? = nil, retaining: Bool = true) async -> ListenerCheck {
        let started = Date()
        let result: (Int32, String)?
        if let readListing { result = await readListing() }
        else { result = try? await run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcu"], environment: environment) }
        let elapsed = String(format: "%.1fs", Date().timeIntervalSince(started))
        guard let result else { return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof could not run") }
        let processes = listingProcesses(result.1).sorted { $0.pid < $1.pid }
        guard let first = processes.first else {
            return ListenerCheck(owned: false, verified: false, description: "? (PID ?)", reason: "lsof exit \(result.0) after \(elapsed) named no listener", absent: true)
        }
        let description = "\(first.name) (PID \(first.pid))"
        let uid = String(getuid())
        guard processes.allSatisfy({ $0.uid == uid }) else {
            let owners = processes.map { "PID \($0.pid) uid \($0.uid)" }.joined(separator: ", ")
            return ListenerCheck(owned: false, verified: false, description: description, reason: "listener owner is not uid \(uid): \(owners)")
        }
        guard processes.count <= 64 else { return ListenerCheck(owned: true, verified: false, description: description, reason: "too many listeners to verify") }
        guard let install else { return ListenerCheck(owned: true, verified: false, description: description, reason: "no installation to verify against") }
        guard Installations.valid(install) else { return ListenerCheck(owned: true, verified: false, description: description, reason: "installation is incomplete") }
        // The CLI owns a child Viewer process. Verify that listener's executable
        // (or the runtime host's stable listener) and its ancestry back to this
        // installation before reusing it or sending a key.
        let packageRoot = Installations.serverPackageRoot(home: URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory()), environment: environment, install: install)
        let server = packageRoot.appendingPathComponent("dist/standalone/server.js").path
        let runtimeHost = packageRoot.appendingPathComponent("dist/runtime-host.mjs").path
        // Only the native keeper's memory may carry trust across app launches.
        // A same-user file, including the former JSON receipt, grants no trust.
        let home = URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory())
        let candidates = processes.compactMap { listenerIdentity($0.pid, install: install, package: packageRoot) }
        let recorded = retaining ? await ListenerKeeper.read(home: home, port: port, identities: candidates) : []
        var identities: [ListenerIdentity] = []
        var refusals: [String] = [], proofs: [String] = []
        for entry in processes {
            guard let identity = listenerIdentity(entry.pid, install: install, package: packageRoot) else {
                refusals.append("PID \(entry.pid) kernel process identity unavailable"); continue
            }
            let outcome = await explainAncestry(listenerPID: entry.pid, bun: install.bun.path, server: server, runtimeHost: runtimeHost,
                cli: install.cli.path, launcherPID: launcher, recorded: recorded.contains(identity), readExecutable: { executablePath($0) },
                readArguments: { processArguments($0) }) { pid in
                await processRow(pid, environment: environment)
            }
            if !outcome.verified { refusals.append("PID \(entry.pid) \(outcome.reason)") }
            else if identity != listenerIdentity(entry.pid, install: install, package: packageRoot) {
                refusals.append("PID \(entry.pid) kernel process identity changed")
            } else { proofs.append("PID \(entry.pid) \(outcome.reason)"); identities.append(identity) }
        }
        if refusals.isEmpty {
            if retaining && launcher != nil && identities != recorded {
                if !(await ListenerKeeper.start(home: home, port: port, identities: identities, install: install, launcher: launcher, environment: environment)) {
                    proofs.append("process identity could not be retained")
                }
            }
            if retaining, let keeper = await ListenerKeeper.pid(home: home, port: port, identities: identities) { proofs.append("native keeper PID \(keeper)") }
            // Starting/querying a keeper yields. Never return the old proof if
            // a retained generation or the selected serving package changed.
            guard Installations.valid(install),
                  Installations.serverPackageRoot(home: home, environment: environment, install: install) == packageRoot,
                  identities.allSatisfy({ listenerIdentity($0.pid, install: install, package: packageRoot) == $0 }) else {
                return ListenerCheck(owned: true, verified: false, description: description, reason: "listener changed during proof retention")
            }
            return ListenerCheck(owned: true, verified: true, description: description, reason: "all listeners have verified installation identity: " + proofs.joined(separator: "; "), identities: identities)
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
    /// Keep argv boundaries: argv[0] may contain an entire forged ps prefix.
    static func runs(arguments: [String], bun: String, script: String) -> Bool {
        let arguments = arguments.map(comparablePath)
        guard arguments.first == comparablePath(bun) else { return false }
        let index = arguments.dropFirst().first == "--bun" ? 2 : 1
        return arguments.count > index && arguments[index] == comparablePath(script)
    }
    static func decodeArguments(_ data: [UInt8]) -> [String]? {
        guard data.count >= MemoryLayout<Int32>.size else { return nil }
        var count: Int32 = 0
        withUnsafeMutableBytes(of: &count) { $0.copyBytes(from: data.prefix(4)) }
        guard count > 0, count <= 65536 else { return nil }
        var cursor = 4
        // KERN_PROCARGS2: argc, saved executable path, NUL padding, argv.
        guard let pathEnd = data[cursor...].firstIndex(of: 0) else { return nil }
        cursor = pathEnd
        while cursor < data.count && data[cursor] == 0 { cursor += 1 }
        var arguments: [String] = []
        for _ in 0..<Int(count) {
            guard cursor < data.count, let end = data[cursor...].firstIndex(of: 0),
                  let argument = String(bytes: data[cursor..<end], encoding: .utf8) else { return nil }
            arguments.append(argument); cursor = end + 1
        }
        return arguments
    }
    static func processArguments(_ pid: Int) -> [String]? {
        #if os(macOS)
        guard pid > 1, pid <= Int(Int32.max) else { return nil }
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, Int32(pid)]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size >= 4, size <= 1_048_576 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0, size <= bytes.count else { return nil }
        return decodeArguments(Array(bytes.prefix(size)))
        #else
        return nil
        #endif
    }
    /// Retention requires the CLI child actually launched by this native app.
    /// Discovery can reuse live ancestry but cannot mint lasting authority.
    static func ownsLauncher(_ pid: Int, parent: Int, install: Installation) -> Bool {
        #if os(macOS)
        guard pid > 1, pid <= Int(Int32.max), parent > 1, parent <= Int(Int32.max) else { return false }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(Int32(pid), PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_uid == getuid(), info.pbi_ppid == UInt32(parent),
              executablePath(pid).map({ Installations.realPath(URL(fileURLWithPath: $0)) }) == Installations.realPath(install.bun),
              let arguments = processArguments(pid) else { return false }
        return runs(arguments: arguments, bun: install.bun.path, script: install.cli.path)
        #else
        return false
        #endif
    }
    static func processRow(_ pid: Int, environment: [String: String]) async -> String? {
        let row = try? await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "pid=,ppid=,command="],
            environment: environment, timeout: 2, outputLimit: nil)
        return row?.0 == 0 ? row?.1 : nil
    }
    /// Kernel executable identity cannot be supplied through argv or a title.
    static func executablePath(_ pid: Int) -> String? {
        #if os(macOS)
        // The SDK's (4*MAXPATHLEN) macro is unavailable to Swift's importer.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let size = buffer.count
        guard proc_pidpath(Int32(pid), &buffer, UInt32(size)) > 0 else { return nil }
        return String(cString: buffer)
        #else
        return try? FileManager.default.destinationOfSymbolicLink(atPath: "/proc/\(pid)/exe")
        #endif
    }
    static func listenerIdentity(_ pid: Int, install: Installation, package: URL) -> ListenerIdentity? {
        #if os(macOS)
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(Int32(pid), PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
        return ListenerIdentity(pid: pid, uid: info.pbi_uid, birth: "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)",
            bun: Installations.realPath(install.bun), cli: Installations.realPath(install.cli), package: Installations.realPath(package))
        #else
        return nil
        #endif
    }
    static func verifyAncestry(listenerPID: Int, bun: String, server: String, runtimeHost: String? = nil, cli: String, launcherPID: Int? = nil,
        readProcess: (Int) async -> String?) async -> Bool {
        await explainAncestry(listenerPID: listenerPID, bun: bun, server: server, runtimeHost: runtimeHost, cli: cli, launcherPID: launcherPID, readProcess: readProcess).verified
    }
    /// Walks from the listener to its ancestors. The Viewer is a process running
    /// the installed Bun on the installed server or runtime host; the launcher is
    /// a process running the installed Bun on the installed CLI, or the CLI
    /// process this app started itself (`launcherPID`). After that CLI exits,
    /// a listener retained by the native keeper with the same kernel birth identity may
    /// reach launchd without it. Missing/changed/cyclic/unreadable rows refuse.
    static func explainAncestry(listenerPID: Int, bun: String, server: String, runtimeHost: String? = nil, cli: String, launcherPID: Int? = nil,
        recorded: Bool = false,
        readExecutable: ((Int) async -> String?)? = nil,
        readArguments: ((Int) -> [String]?)? = nil,
        readProcess: (Int) async -> String?) async -> (verified: Bool, reason: String) {
        let bun = comparablePath(bun), server = comparablePath(server), cli = comparablePath(cli)
        let runtimeHost = runtimeHost.map(comparablePath)
        var cursor = listenerPID
        var visited = Set<Int>()
        var chain: [String] = []
        var foundViewer = false
        var listenerRunsViewer = false
        var foundLauncher = false
        var installedExecutable = false
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
            let arguments = readArguments?(cursor)
            if readArguments != nil && arguments == nil { return (false, "process arguments unavailable for PID \(cursor)") }
            func running(_ script: String) -> Bool {
                if let arguments { return runs(arguments: arguments, bun: bun, script: script) }
                return runs(command, bun: bun, script: script)
            }
            var roles: [String] = []
            if running(server) || runtimeHost.map({ running($0) }) == true {
                foundViewer = true
                if cursor == listenerPID { listenerRunsViewer = true }
                roles.append("viewer")
            }
            if launcherPID == cursor || running(cli) {
                if let readExecutable, readArguments != nil {
                    guard let executable = await readExecutable(cursor),
                          comparablePath(Installations.realPath(URL(fileURLWithPath: executable))) == comparablePath(Installations.realPath(URL(fileURLWithPath: bun))),
                          await readProcess(cursor) == row, readArguments?(cursor) == arguments else {
                        return (false, "CLI executable or arguments changed: \(walked())")
                    }
                }
                foundLauncher = true; roles.append("launcher")
            }
            chain.append("\(cursor)[\(roles.isEmpty ? "other" : roles.joined(separator: "+"))] \(command.prefix(240))")
            if !listenerRunsViewer { return (false, "listener PID does not run the installed Viewer or runtime host: \(walked())") }
            if cursor == listenerPID, let readExecutable {
                guard let executable = await readExecutable(cursor),
                      comparablePath(Installations.realPath(URL(fileURLWithPath: executable))) == comparablePath(Installations.realPath(URL(fileURLWithPath: bun))) else {
                    return (false, "listener executable is not the installed Bun: \(walked())")
                }
                installedExecutable = true
                guard Date() < deadline, await readProcess(cursor) == row,
                      readArguments == nil || readArguments?(cursor) == arguments else {
                    return (false, "listener changed during executable verification: \(walked())")
                }
            }
            if foundViewer && foundLauncher { return (true, "verified \(walked())") }
            cursor = parent
        }
        if cursor == 1 && foundViewer && installedExecutable && recorded {
            return (true, "verified keeper-retained listener without CLI ancestry: \(walked())")
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
