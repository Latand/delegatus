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
    static func probe(home: URL, environment: [String: String], address: URL = address) async -> Probe {
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
    static func run(_ executable: String, _ arguments: [String], environment: [String: String], output: FileHandle? = nil, timeout: Double = 15) async throws -> (Int32, String) {
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
                    continuation.resume(returning: (process.terminationStatus, String(data: bytes.suffix(32768), encoding: .utf8) ?? ""))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    static func listener(environment: [String: String]) async -> (owned: Bool, description: String) {
        let result = try? await run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:8898", "-sTCP:LISTEN", "-Fpcu"], environment: environment)
        let lines = (result?.1 ?? "").split(separator: "\n").map(String.init)
        let owner = "u\(getuid())"
        let owned = lines.contains(owner)
        let pid = lines.first(where: { $0.hasPrefix("p") }).map { String($0.dropFirst()) } ?? "?"
        let name = lines.first(where: { $0.hasPrefix("c") }).map { String($0.dropFirst()) } ?? "?"
        return (owned, "\(name) (PID \(pid))")
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
