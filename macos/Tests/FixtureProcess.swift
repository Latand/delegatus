import Foundation

enum FixtureProcess {
    struct Handshake: Decodable {
        let pid: Int
        let port: Int
        let cli: Int
        let keeper: Int?
    }

    static func handshake(_ pipe: Pipe, named name: String) throws -> Handshake {
        let line = try readyLine(pipe, named: name)
        guard let result = try? JSONDecoder().decode(Handshake.self, from: line),
              (2...Int(Int32.max)).contains(result.pid), (1...65535).contains(result.port),
              (2...Int(Int32.max)).contains(result.cli),
              result.keeper.map({ (2...Int(Int32.max)).contains($0) }) ?? true else {
            throw LauncherError.message("\(name): invalid process handshake")
        }
        return result
    }

    static func readyLine(_ pipe: Pipe, named name: String, timeout: Double = 10, deadlineEnabled: Bool = true) throws -> Data {
        let fd = pipe.fileHandleForReading.fileDescriptor
        let deadline = DispatchTime.now() + timeout
        var line = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let now = DispatchTime.now()
            guard !deadlineEnabled || now < deadline else { break }
            let remaining = deadlineEnabled ? deadline.uptimeNanoseconds - now.uptimeNanoseconds : UInt64.max
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let milliseconds = deadlineEnabled ? Int32((remaining + 999_999) / 1_000_000) : -1
            let ready = poll(&event, 1, milliseconds)
            if ready == 0 { break }
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { throw LauncherError.message("\(name): readiness poll failed (errno \(errno))") }
            // This is the only reader. POLLHUP also wakes poll, so read can
            // distinguish EOF from a writer that is still alive and silent.
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw LauncherError.message("\(name): readiness read failed (errno \(errno))") }
            guard count != 0 else { throw LauncherError.message("\(name): stdout closed before readiness line") }
            let bytes = buffer.prefix(count)
            let newline = bytes.firstIndex(of: 10)
            line.append(contentsOf: bytes[..<(newline ?? bytes.endIndex)])
            guard line.count < 8192 else { throw LauncherError.message("\(name): oversized readiness line") }
            if newline != nil { return line }
        }
        throw LauncherError.message("\(name): timed out waiting for readiness line")
    }

    static func stop(_ child: Process, grace: Double = 2) -> Bool {
        if !child.isRunning { return true }
        child.terminate()
        if exited(child, within: grace) { return true }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        return exited(child, within: 2)
    }

    static func exited(_ child: Process, within timeout: Double) -> Bool {
        let deadline = DispatchTime.now() + timeout
        while child.isRunning && DispatchTime.now() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        return !child.isRunning
    }
}
