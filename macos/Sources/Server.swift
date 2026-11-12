import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum Probe: Equatable { case ready(String?), free, busy, waiting }

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
    static func probe(home: URL, environment: [String: String], install: Installation? = nil, address: URL = address) async -> Probe {
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
            guard var http = response as? HTTPURLResponse else { return .busy }
            var usedKey: String? = nil
            if [401, 403].contains(http.statusCode), let key = key(home: home, environment: environment) {
                // A refusal alone does not prove that the listener is Delegatus.
                // Verify the process and its executable paths before sending a key.
                guard let install, Installations.valid(install), await listener(environment: environment, install: install, port: address.port ?? 8898).verified else { return .busy }
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                (data, response) = try await session.data(for: request)
                guard let retry = response as? HTTPURLResponse else { return .busy }
                http = retry; usedKey = key
            }
            return classify(status: http.statusCode, marker: http.value(forHTTPHeaderField: "x-delegatus-diagnostics"), key: usedKey)
        } catch let error as URLError {
            return error.code == .cannotConnectToHost ? .free : .waiting
        } catch { return .waiting }
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
    static func listener(environment: [String: String], install: Installation? = nil, port: Int = 8898) async -> (owned: Bool, verified: Bool, description: String) {
        let result = try? await run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcu"], environment: environment)
        let lines = (result?.1 ?? "").split(separator: "\n").map(String.init)
        let owner = "u\(getuid())"
        let owned = lines.contains(owner)
        let pid = lines.first(where: { $0.hasPrefix("p") }).map { String($0.dropFirst()) } ?? "?"
        let name = lines.first(where: { $0.hasPrefix("c") }).map { String($0.dropFirst()) } ?? "?"
        var verified = false
        if owned, let install, Installations.valid(install), let listenerPID = Int(pid) {
            // The CLI owns a child Viewer process. Verify that listener's executable
            // (or the runtime host's stable listener) and its ancestry back to this
            // installation before reusing it or sending a key.
            let packageRoot = Installations.serverPackageRoot(home: URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory()), environment: environment, install: install)
            verified = await verifyAncestry(listenerPID: listenerPID, bun: install.bun.path,
                server: packageRoot.appendingPathComponent("dist/standalone/server.js").path,
                runtimeHost: packageRoot.appendingPathComponent("dist/runtime-host.mjs").path,
                cli: install.cli.path) { pid in
                await processRow(pid, environment: environment)
            }
        }
        return (owned, verified, "\(name) (PID \(pid))")
    }
    static func processRow(_ pid: Int, environment: [String: String]) async -> String? {
        let row = try? await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "pid=,ppid=,command="],
            environment: environment, timeout: 2, outputLimit: nil)
        return row?.0 == 0 ? row?.1 : nil
    }
    static func verifyAncestry(listenerPID: Int, bun: String, server: String, runtimeHost: String? = nil, cli: String,
        readProcess: (Int) async -> String?) async -> Bool {
        var cursor = listenerPID
        var visited = Set<Int>()
        var foundViewer = false
        var foundLauncher = false
        let deadline = Date().addingTimeInterval(10)
        // Query only this listener and its parents. Diagnostic tail limits must
        // never discard process identity, even for a long Unicode command.
        while cursor > 1, visited.count < 64, visited.insert(cursor).inserted, Date() < deadline {
            guard let row = await readProcess(cursor), Date() < deadline else { return false }
            let fields = row.split(maxSplits: 2, whereSeparator: \.isWhitespace)
            guard fields.count == 3, Int(fields[0]) == cursor, let parent = Int(fields[1]) else { return false }
            let command = String(fields[2])
            if command.contains(bun) && (command.contains(server) || runtimeHost.map { command.contains($0) } == true) {
                foundViewer = true
            }
            if command.contains(bun), command.contains(cli) { foundLauncher = true }
            if foundViewer && foundLauncher { return true }
            cursor = parent
        }
        return false
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
