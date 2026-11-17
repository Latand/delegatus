import Foundation
#if os(macOS)
import Darwin
import CryptoKit
#endif

/// A headless copy of this native executable retains a verified process
/// generation in memory. It never reads a receipt, accepts supplied identities,
/// probes HTTP, reads access keys, or signals the server.
enum ListenerKeeper {
    static let option = "--retain-listener"
    static var executable: String { Server.executablePath(Int(getpid())) ?? "" }

    static func socketPath(home: URL, port: Int, identities: [ListenerIdentity]) -> String {
        #if os(macOS)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var input = Data("\(Installations.realPath(home)):\(port):".utf8)
        input.append((try? encoder.encode(identities.sorted { $0.pid < $1.pid })) ?? Data())
        let name = SHA256.hash(data: input).prefix(12).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.temporaryDirectory.appendingPathComponent("delegatus-\(name).sock").path
        #else
        return ""
        #endif
    }

    #if os(macOS)
    static func socketAddress(_ path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { target in
            bytes.withUnsafeBytes { source in target.copyBytes(from: source) }
        }
        return address
    }
    static func configure(_ fd: Int32) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
        fcntl(fd, F_SETFD, FD_CLOEXEC)
    }
    static func connectSocket(_ fd: Int32, address: inout sockaddr_un) -> Bool {
        fcntl(fd, F_SETFL, O_NONBLOCK)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if result != 0 {
            guard errno == EINPROGRESS else { return false }
            var event = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            var error: Int32 = 0, size = socklen_t(MemoryLayout<Int32>.size)
            guard poll(&event, 1, 1000) > 0,
                  getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0, error == 0 else { return false }
        }
        fcntl(fd, F_SETFL, 0)
        return true
    }
    static func readSocket(home: URL, port: Int, identities expected: [ListenerIdentity], peer: ((Int32) -> Void)? = nil) -> [ListenerIdentity] {
        guard var address = socketAddress(socketPath(home: home, port: port, identities: expected)) else { return [] }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return [] }
        defer { close(fd) }
        configure(fd)
        guard connectSocket(fd, address: &address) else { return [] }
        // These are properties of the connected peer, unaffected by socket
        // replacement, JSON contents, argv, or the peer's process title.
        var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
        var size = socklen_t(MemoryLayout.size(ofValue: pid))
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
              size == MemoryLayout.size(ofValue: pid),
              Server.executablePath(Int(pid)) == executable else { return [] }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while data.count <= 32768 {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count >= 0 else { return [] }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        guard data.count <= 32768,
              let identities = try? JSONDecoder().decode([ListenerIdentity].self, from: data),
              !identities.isEmpty, identities.count <= 64 else { return [] }
        peer?(pid)
        return identities
    }
    #endif

    static func read(home: URL, port: Int, identities: [ListenerIdentity]) async -> [ListenerIdentity] {
        #if os(macOS)
        // Socket deadlines run off the app's main actor.
        return await Task.detached { readSocket(home: home, port: port, identities: identities) }.value
        #else
        return []
        #endif
    }

    static func pid(home: URL, port: Int, identities: [ListenerIdentity]) async -> Int32? {
        #if os(macOS)
        return await Task.detached {
            var result: Int32?
            _ = readSocket(home: home, port: port, identities: identities, peer: { result = $0 })
            return result
        }.value
        #else
        return nil
        #endif
    }

    static func start(home: URL, port: Int, identities: [ListenerIdentity], install: Installation, launcher: Int?, environment: [String: String]) async -> Bool {
        guard !executable.isEmpty, let launcher,
              Server.ownsLauncher(launcher, parent: Int(getpid()), install: install) else { return false }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = [option, install.bun.path, install.cli.path, String(port), String(launcher)]
        child.environment = environment
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        do { try child.run() } catch { return false }
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if await read(home: home, port: port, identities: identities) == identities { return true }
            if !child.isRunning { return false }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        // This is our own child; a failed bootstrap retains no idle helper.
        if child.isRunning { child.terminate() }
        let cleanupDeadline = Date().addingTimeInterval(1)
        while child.isRunning && Date() < cleanupDeadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        await Task.detached { child.waitUntilExit() }.value
        return false
    }

    static func runIfRequested() async -> Bool {
        let args = CommandLine.arguments
        guard args.dropFirst().first == option else { return false }
        #if os(macOS)
        guard args.count == 6, let port = Int(args[4]), (1...65535).contains(port) else { return true }
        let environment = ProcessInfo.processInfo.environment
        let home = URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory())
        let install = Installation(bun: URL(fileURLWithPath: args[2]), cli: URL(fileURLWithPath: args[3]))
        // Retained trust starts only with this native app's own CLI child.
        // Parent identity alone cannot authorize a listener found in discovery.
        let parent = Int(getppid())
        let package = Installations.serverPackageRoot(home: home, environment: environment, install: install)
        guard parent > 1, Server.executablePath(parent) == executable,
              let origin = Server.listenerIdentity(parent, install: install, package: package) else { return true }
        guard let launcher = Int(args[5]), launcher > 1,
              Server.ownsLauncher(launcher, parent: parent, install: install),
              let cliOrigin = Server.listenerIdentity(launcher, install: install, package: package) else { return true }
        let check = await Server.listener(environment: environment, install: install, port: port, launcher: launcher, retaining: false)
        guard check.verified, Int(getppid()) == parent,
              Server.executablePath(parent) == executable,
              Server.listenerIdentity(parent, install: install, package: package) == origin,
              Server.ownsLauncher(launcher, parent: parent, install: install),
              Server.listenerIdentity(launcher, install: install, package: package) == cliOrigin,
              Installations.serverPackageRoot(home: home, environment: environment, install: install) == package else { return true }
        let identities = check.identities
        guard !identities.isEmpty, identities.count <= 64,
              let data = try? JSONEncoder().encode(identities), data.count <= 32768 else { return true }
        let path = socketPath(home: home, port: port, identities: identities)
        guard var address = socketAddress(path) else { return true }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return true }
        defer { close(fd) }
        configure(fd)
        // Refuse an existing live endpoint. Remove only a stale owned socket.
        if !readSocket(home: home, port: port, identities: identities).isEmpty { return true }
        var prior = stat()
        if lstat(path, &prior) == 0 {
            guard prior.st_uid == getuid(), prior.st_mode & S_IFMT == S_IFSOCK else { return true }
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            guard probe >= 0 else { return true }
            let connected = connectSocket(probe, address: &address)
            let refused = !connected && errno == ECONNREFUSED
            close(probe)
            guard refused else { return true }
            unlink(path)
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { return true }
        chmod(path, 0o600)
        var owned = stat()
        guard lstat(path, &owned) == 0 else { return true }
        defer {
            var current = stat()
            if lstat(path, &current) == 0, current.st_ino == owned.st_ino { unlink(path) }
        }
        guard listen(fd, 8) == 0 else { return true }
        // The retained generation owns this helper's lifetime. No registry scan
        // and no HTTP work; one bounded poll, then a fresh kernel comparison.
        while identities.allSatisfy({ Server.listenerIdentity($0.pid, install: install, package: package) == $0 }) {
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&event, 1, 1000)
            if ready < 0 { break }
            guard ready > 0 else { continue }
            guard identities.allSatisfy({ Server.listenerIdentity($0.pid, install: install, package: package) == $0 }) else { break }
            let peer = accept(fd, nil, nil)
            if peer >= 0 {
                configure(peer)
                data.withUnsafeBytes { bytes in
                    if let base = bytes.baseAddress {
                        var offset = 0
                        while offset < bytes.count {
                            let count = Darwin.write(peer, base.advanced(by: offset), bytes.count - offset)
                            if count <= 0 { break }
                            offset += count
                        }
                    }
                }
                close(peer)
            }
        }
        #endif
        return true
    }
}
