import AppKit
import CoreGraphics
import WebKit

@MainActor final class Evidence {
    let directory: URL?
    let logURL: URL
    let handle: FileHandle
    let home: URL
    private var frame = 0
    private var filters: [Process] = []
    init(home: URL) throws {
        self.home = home
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--evidence-dir"), i + 1 < args.count {
            directory = URL(fileURLWithPath: args[i + 1], isDirectory: true)
        } else { directory = nil }
        let logs = home.appendingPathComponent("Library/Logs/Delegatus")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let old = (try? FileManager.default.contentsOfDirectory(at: logs, includingPropertiesForKeys: nil)) ?? []
        for file in old.filter({ $0.lastPathComponent.hasPrefix("app-") }).sorted(by: { $0.lastPathComponent > $1.lastPathComponent }).dropFirst(9) {
            try? FileManager.default.removeItem(at: file)
        }
        logURL = logs.appendingPathComponent("app-\(ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-"))-\(getpid()).log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        handle = try FileHandle(forWritingTo: logURL)
        if let directory { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    }
    func redact(_ text: String) -> String {
        text.replacingOccurrences(of: home.path, with: "$HOME")
            .replacingOccurrences(of: "(?i)([?&]k=|Bearer )[A-Za-z0-9%._~-]+", with: "$1[redacted]", options: .regularExpression)
            .replacingOccurrences(of: "\\b[0-9a-f]{32}\\b", with: "[redacted]", options: .regularExpression)
    }
    func log(_ text: String) { try? handle.write(contentsOf: Data((redact(text) + "\n").utf8)) }
    func tail(_ url: URL? = nil) -> String {
        guard let file = try? FileHandle(forReadingFrom: url ?? logURL) else { return "" }
        defer { try? file.close() }
        guard let size = try? file.seekToEnd() else { return "" }
        try? file.seek(toOffset: size > 8192 ? size - 8192 : 0)
        let bytes = (try? file.readToEnd()) ?? Data()
        return redact(String(decoding: bytes, as: UTF8.self)).split(separator: "\n").suffix(6).joined(separator: "\n")
    }
    func redirect(_ child: Process) throws {
        // The filter outlives the window alongside the launcher, consuming full
        // lines so a split write cannot expose an access key in the log.
        let pipe = Pipe()
        let filter = Process(); filter.executableURL = URL(fileURLWithPath: "/usr/bin/sed")
        filter.arguments = ["-l", "-E", "-e", "s/([?&]k=|Bearer )[A-Za-z0-9%._~-]+/\\1[redacted]/g", "-e", "s/[0-9a-f]{32}/[redacted]/g"]
        filter.standardInput = pipe; filter.standardOutput = handle; filter.standardError = FileHandle.nullDevice
        child.standardOutput = pipe; child.standardError = pipe
        try filter.run(); filters.append(filter)
    }
    func capture(_ window: NSWindow, name: String, completion: (() -> Void)? = nil) {
        guard let directory else { return }
        frame += 1
        let destination = directory.appendingPathComponent(String(format: "%03d-%@.png", frame, name))
        scheduleCapture(name: name, completion: completion) {
            self.writeWindow(CGWindowID(window.windowNumber), to: destination, name: name)
        }
    }
    func captureMenu(name: String, completion: (() -> Void)? = nil) {
        guard let directory else { return }
        frame += 1
        let destination = directory.appendingPathComponent(String(format: "%03d-%@.png", frame, name))
        // Menus use their own WindowServer window. Capture that app-owned
        // window while tracking runs, avoiding a whole-screen capture and its
        // Screen Recording permission prompt.
        scheduleCapture(name: name, completion: completion) {
            let windows = (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]) ?? []
            let menuWindow = windows.first { row in
                (row[kCGWindowOwnerPID as String] as? Int) == Int(getpid())
                    && (row[kCGWindowLayer as String] as? Int ?? 0) > 0
                    && (row[kCGWindowNumber as String] as? Int) != nil
            }?[kCGWindowNumber as String] as? Int
            guard let menuWindow else { self.log("CAPTURE failed \(name)"); return }
            self.writeWindow(CGWindowID(menuWindow), to: destination, name: name)
        }
    }
    private func scheduleCapture(name: String, completion: (() -> Void)?, capture: @escaping () -> Void) {
        let timer = Timer(timeInterval: 0.5, repeats: false) { _ in
            MainActor.assumeIsolated {
                defer { completion?() }
                capture()
            }
        }
        for mode in [RunLoop.Mode.common, .eventTracking, .modalPanel] { RunLoop.main.add(timer, forMode: mode) }
    }
    private func writeWindow(_ window: CGWindowID, to destination: URL, name: String) {
        guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, window, [.bestResolution]),
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            log("CAPTURE failed \(name)"); return
        }
        do {
            try png.write(to: destination)
            log("CAPTURED \(name)")
        } catch { log("CAPTURE failed \(name)") }
    }
}
