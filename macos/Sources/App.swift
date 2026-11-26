import AppKit
import WebKit

func text(_ key: String) -> String { NSLocalizedString(key, comment: "") }

@main @MainActor final class App: NSObject, NSApplicationDelegate, NSToolbarDelegate, NSMenuItemValidation {
    static func main() {
        if CommandLine.arguments.dropFirst().first == ListenerKeeper.option {
            Task.detached { _ = await ListenerKeeper.runIfRequested(); exit(0) }
            dispatchMain()
        }
        let application = NSApplication.shared
        let delegate = App()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
    let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory(), isDirectory: true)
    var language: String { Bundle.main.preferredLocalizations.first == "uk" ? "uk" : "en" }
    var window: NSWindow!
    var status: NSView!
    var detail: NSTextField!
    var web: Browser!
    var evidence: Evidence!
    var install: Installation?
    var manifest: RuntimeManifest!
    var setup: Process?
    var launcher: Process?
    var operation: Task<Void, Never>?
    var monitor: Task<Void, Never>?
    var state = ""
    var pageURL = Server.address
    var address = Server.address
    var serviceMenu: NSMenuItem!
    var stopMenu: NSMenuItem!
    var legacyInstallation = false
    var generation = 0
    var busy = false
    var quittingAfterSetup = false
    var cancellingSetup = false
    var environment: [String: String] { Installations.childEnvironment(home: home, install: install, language: language) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            evidence = try Evidence(home: home)
            // Native smoke uses a disposable loopback port. Normal launches
            // retain the manifest's address and never read this option.
            if evidence.directory != nil, let i = CommandLine.arguments.firstIndex(of: "--evidence-port"),
               i + 1 < CommandLine.arguments.count, let port = Int(CommandLine.arguments[i + 1]),
               (1024...65535).contains(port) {
                address = URL(string: "http://127.0.0.1:\(port)")!
                pageURL = address
            }
            let resource = Bundle.main.resourceURL!.appendingPathComponent("runtime-manifest.json")
            manifest = try JSONDecoder().decode(RuntimeManifest.self, from: Data(contentsOf: resource))
            guard manifest.port == 8898 else { throw LauncherError.message("manifest-invalid") }
        } catch {
            let alert = NSAlert(); alert.messageText = text("bundle-error"); alert.runModal(); NSApp.terminate(nil); return
        }
        if evidence.directory != nil {
            NSApp.appearance = NSAppearance(named: CommandLine.arguments.contains("Dark") ? .darkAqua : .aqua)
        }
        let initialSize = CommandLine.arguments.contains("--evidence-minimum-size") ? NSSize(width: 680, height: 500) : NSSize(width: 1100, height: 780)
        let windowSize = CommandLine.arguments.contains("--evidence-intermediate-size") ? NSSize(width: 890, height: 640) : initialSize
        window = NSWindow(contentRect: NSRect(origin: .zero, size: windowSize), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Delegatus"; window.minSize = NSSize(width: 680, height: 500); window.center()
        window.isReleasedWhenClosed = false
        web = Browser(evidence: evidence, window: window, port: address.port!)
        let toolbar = NSToolbar(identifier: "navigation"); toolbar.delegate = self
        window.toolbar = toolbar
        buildMenus()
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if evidence.directory != nil, let index = CommandLine.arguments.firstIndex(of: "--evidence-surface"), index + 1 < CommandLine.arguments.count {
            presentEvidenceSurface(CommandLine.arguments[index + 1]); return
        }
        if evidence.directory != nil && CommandLine.arguments.contains("--evidence-error") {
            failed(LauncherError.message("install-failed")); return
        }
        begin()
    }
    func presentEvidenceSurface(_ surface: String) {
        evidence.log("SURFACE \(surface)")
        switch surface {
        case "install": presentInstallation()
        case "installing": show("installing", actions: [("cancel", #selector(cancelInstall)), ("logs", #selector(logs))])
        case "access-unavailable": accessUnavailable("1.11.0")
        case "open-existing": portBusy(ListenerCheck(owned: true, verified: true, description: "Delegatus", reason: "evidence"))
        case "cancelling": presentCancellation()
        case "menu":
            guard let menu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
            let capture = evidence.captureMenu(name: "menu") { menu.cancelTracking() }
            defer { capture?.invalidate() }
            menu.popUp(positioning: nil, at: NSPoint(x: 18, y: window.frame.height - 42), in: window.contentView)
            evidence.log("SURFACE-CLOSED menu")
        case "stop", "login", "update", "quit":
            _ = confirm(surface, capture: true)
            evidence.log("SURFACE-CLOSED \(surface)")
        default: show("failed", message: text("operation-failed"))
        }
    }
    func presentInstallation() {
        #if arch(arm64)
        let bunBytes = manifest.bun.arm64.bytes
        #else
        let bunBytes = manifest.bun.x86_64.bytes
        #endif
        let mb = (bunBytes + manifest.delegatus.bytes) / 1_000_000
        show("needs-install", message: String(format: text("install-question"), manifest.bun.version, manifest.delegatus.version, mb),
            actions: [("install", #selector(installRuntime)), ("quit", #selector(quit))])
    }
    func presentCancellation() {
        show("installing", message: text("cancel-cleanup"), actions: [("logs", #selector(logs))])
    }
    func confirm(_ surface: String, capture: Bool = false) -> Bool {
        let title: String
        let detail: String
        let buttons: [String]
        switch surface {
        case "stop": title = "stop-question"; detail = "stop-warning"; buttons = ["stop", "cancel"]
        case "login": title = "login-remove-question"; detail = ""; buttons = ["ok", "cancel"]
        case "update": title = "app-update"; detail = ""; buttons = ["download", "cancel"]
        case "quit": title = "quit-question"; detail = "quit-detail"; buttons = ["keep-running", "cancel"]
        default: return false
        }
        let alert = NSAlert(); alert.messageText = text(title); alert.informativeText = detail.isEmpty ? "" : text(detail)
        for button in buttons { alert.addButton(withTitle: text(button)) }
        if capture {
            evidence.capture(alert.window, name: "dialog-\(surface)") {
                alert.buttons.last?.performClick(nil)
            }
        }
        return alert.runModal() == .alertFirstButtonReturn
    }
    func item(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: text(title), action: action, keyEquivalent: key); item.target = self; menu.addItem(item); return item
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(stop) || menuItem.action == #selector(toggleLogin) {
            return !legacyInstallation
        }
        return true
    }
    func buildMenus() {
        let main = NSMenu(); NSApp.mainMenu = main
        let application = NSMenu(); let root = NSMenuItem(); root.title = "Delegatus"; root.submenu = application; main.addItem(root)
        _ = item(application, "about", #selector(about))
        _ = item(application, "update", #selector(update))
        serviceMenu = item(application, "login", #selector(toggleLogin))
        application.addItem(.separator())
        _ = item(application, "start", #selector(retry))
        stopMenu = item(application, "stop", #selector(stop))
        _ = item(application, "logs", #selector(logs))
        application.addItem(.separator()); _ = item(application, "quit", #selector(quit), key: "q")
        let edit = NSMenu(title: text("edit")); let editRoot = NSMenuItem(); editRoot.title = text("edit"); editRoot.submenu = edit; main.addItem(editRoot)
        for (title, action, key) in [("undo", "undo:", "z"), ("redo", "redo:", "Z"), ("cut", "cut:", "x"), ("copy", "copy:", "c"), ("paste", "paste:", "v"), ("select-all", "selectAll:", "a")] {
            edit.addItem(withTitle: text(title), action: Selector(action), keyEquivalent: key)
        }
        let view = NSMenu(title: text("view")); let viewRoot = NSMenuItem(); viewRoot.title = text("view"); viewRoot.submenu = view; main.addItem(viewRoot)
        _ = item(view, "back", #selector(back), key: "["); _ = item(view, "forward", #selector(forward), key: "]")
        _ = item(view, "reload", #selector(reload), key: "r"); _ = item(view, "browser", #selector(openBrowser))
        let windows = NSMenu(title: text("window")); let windowRoot = NSMenuItem(); windowRoot.title = text("window"); windowRoot.submenu = windows; main.addItem(windowRoot); NSApp.windowsMenu = windows
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [NSToolbarItem.Identifier("back"), NSToolbarItem.Identifier("forward"), NSToolbarItem.Identifier("reload"), .flexibleSpace] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let actions: [String: Selector] = ["back": #selector(back), "forward": #selector(forward), "reload": #selector(reload)]
        guard let action = actions[identifier.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier); item.label = text(identifier.rawValue)
        item.target = self; item.action = action; return item
    }
    func show(_ next: String, message: String? = nil, actions: [(String, Selector)] = []) {
        state = next; evidence.log("STATE \(next)" + (message.map { " \($0)" } ?? ""))
        status = NSView(frame: window.contentView!.bounds)
        let icon = NSImageView(); icon.image = NSApp.applicationIconImage; icon.setFrameSize(NSSize(width: 88, height: 88))
        icon.widthAnchor.constraint(equalToConstant: 88).isActive = true; icon.heightAnchor.constraint(equalToConstant: 88).isActive = true
        let title = NSTextField(wrappingLabelWithString: text(next)); title.font = .systemFont(ofSize: 25, weight: .semibold); title.alignment = .center
        detail = NSTextField(wrappingLabelWithString: message ?? text(next + "-detail")); detail.alignment = .center
        detail.maximumNumberOfLines = 10
        let buttons = NSStackView(); buttons.orientation = .horizontal; buttons.spacing = 12
        var existingButton: NSButton?
        for (label, action) in actions {
            let button = NSButton(title: text(label), target: self, action: action); button.bezelStyle = .rounded; buttons.addArrangedSubview(button)
            if label == "open-existing" { existingButton = button }
        }
        let stack = NSStackView(views: [icon, title, detail, buttons]); stack.orientation = .vertical; stack.spacing = 22; stack.translatesAutoresizingMaskIntoConstraints = false
        status.addSubview(stack); window.contentView = status
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: status.centerXAnchor), stack.centerYAnchor.constraint(equalTo: status.centerYAnchor), stack.widthAnchor.constraint(equalToConstant: 560)])
        status.layoutSubtreeIfNeeded(); window.displayIfNeeded()
        evidence.log("ACTIONS " + actions.map { $0.0 }.joined(separator: ","))
        evidence.capture(window, name: next) { [weak self] in
            if self?.evidence.directory != nil, CommandLine.arguments.contains("--evidence-open-existing"), let button = existingButton {
                self?.evidence.log("ACTION open-existing"); button.performClick(nil)
            }
        }
    }
    func begin(using retainedInstall: Installation? = nil) {
        guard !busy else { return }
        generation += 1; let token = generation
        operation?.cancel(); monitor?.cancel()
        busy = true
        operation = Task { defer { if generation == token && setup == nil { busy = false } }
            do {
                install = try (retainedInstall ?? Installations.discover(home))
                let community = Installations.community(home)
                if Installations.valid(community) {
                    let communityEnvironment = Installations.childEnvironment(home: home, install: community, language: language)
                    let listener = await Server.listener(environment: communityEnvironment, install: community, port: address.port!)
                    guard !Task.isCancelled, generation == token else { return }
                    if listener.verified { install = community }
                }
                serviceMenu.state = install?.service == nil ? .off : .on
                let legacy = install.flatMap { Installations.legacyVersion(home: home, environment: environment, install: $0) } != nil
                legacyInstallation = legacy
                // The released legacy CLI has no stop or service subcommands.
                // Keep these controls unavailable while that installation is reused.
                serviceMenu.isEnabled = !legacy
                stopMenu.isEnabled = !legacy
                if evidence.directory != nil {
                    NSApp.mainMenu?.item(at: 0)?.submenu?.update()
                    evidence.log("MENU-VALIDATED stop=\(stopMenu.isEnabled ? "enabled" : "disabled") login=\(serviceMenu.isEnabled ? "enabled" : "disabled")")
                }
                let (probe, observed) = await Server.inspect(home: home, environment: environment, install: install, address: address)
                guard !Task.isCancelled, generation == token else { return }
                if probe != .free { evidence.log("PROBE \(probe.label) \(observed)") }
                if case .ready(let key) = probe {
                    let listener = await Server.listener(environment: environment, install: install, port: address.port!)
                    guard !Task.isCancelled, generation == token else { return }
                    evidence.log("LISTENER \(listener.verified ? "verified" : "refused") \(listener.description): \(listener.reason)")
                    if listener.verified { ready(key: key, reused: true); return }
                    let blocks = await listenerBlocksStart(listener)
                    guard !Task.isCancelled, generation == token else { return }
                    if blocks { portBusy(listener); return }
                }
                if case .accessUnavailable(let version) = probe { accessUnavailable(version); return }
                if probe == .busy || probe == .waiting {
                    let listener = await Server.listener(environment: environment, install: install, port: address.port!)
                    guard !Task.isCancelled, generation == token else { return }
                    evidence.log("LISTENER \(listener.description): \(listener.reason)")
                    if listener.canOpen { portBusy(listener); return }
                    let blocks = await listenerBlocksStart(listener)
                    guard !Task.isCancelled, generation == token else { return }
                    if blocks { portBusy(listener); return }
                }
                guard let install else {
                    presentInstallation()
                    if CommandLine.arguments.contains("--accept-install") { busy = false; installRuntime() }
                    return
                }
                let privateBun = Installations.runtime(home).appendingPathComponent("bun/bin/bun")
                if install.bun == privateBun {
                    let result = try await Server.run(install.bun.path, ["--version"], environment: environment)
                    guard result.0 == 0, let current = Version(result.1), let pinned = Version(manifest.bun.version) else { throw LauncherError.message("install-failed") }
                    guard !Task.isCancelled, generation == token else { return }
                    if current < pinned { busy = false; installRuntime(); return }
                }
                try await start(install, token: token)
            } catch { if generation == token { failed(error) } }
        }
    }
    func accessUnavailable(_ version: String) {
        show("access-unavailable", message: String(format: text("access-unavailable-detail"), version),
            actions: [("open-existing", #selector(openExisting)), ("retry", #selector(retry)), ("logs", #selector(logs))])
    }
    func portBusy(_ listener: ListenerCheck) {
        var actions = [("retry", #selector(retry)), ("logs", #selector(logs))]
        if listener.canOpen { actions.insert(("open-existing", #selector(openExisting)), at: 0) }
        let message = listener.canOpen ? text("port-existing") : listener.owned ? String(format: text("port-owner"), listener.description) : text("port-other-user")
        show("port-busy", message: message, actions: actions)
        evidence.log("OPEN-EXISTING \(listener.canOpen ? "available" : "withheld")")
    }
    @objc func openExisting() {
        guard !busy else { return }
        generation += 1; let token = generation
        operation?.cancel(); monitor?.cancel(); busy = true
        operation = Task { defer { if generation == token { busy = false } }
            let probe = await Server.probe(home: home, environment: environment, install: install, address: address)
            guard !Task.isCancelled, generation == token else { return }
            let listener = await Server.listener(environment: environment, install: install, port: address.port!)
            guard !Task.isCancelled, generation == token else { return }
            guard listener.canOpen else { portBusy(listener); return }
            let key = Server.existingKey(probe, listener: listener)
            // A refused/missing key opens a fresh cookie jar, so the page can
            // ask for its key without inheriting saved browser credentials.
            web = Browser(evidence: evidence, window: window, port: address.port!, persistent: key != nil)
            ready(key: key, reused: true, monitorHealth: false)
        }
    }
    func listenerBlocksStart(_ listener: ListenerCheck) async -> Bool {
        var recheck: Probe? = nil
        if listener.absent {
            // This request carries no key and cannot accept readiness. It only
            // distinguishes a departed listener from one hidden by ownership.
            let (probe, detail) = await Server.inspect(home: home, environment: environment, address: address)
            if Task.isCancelled { return false }
            evidence.log("LISTENER absent; recheck \(probe.label) \(detail)")
            recheck = probe
        }
        return Server.listenerDecision(listener, recheck: recheck) != .wait
    }
    func start(_ install: Installation, token: Int) async throws {
        show("starting")
        if let plist = install.service { try await Server.startService(plist, environment: environment) }
        else {
            let child = Process(); child.executableURL = install.bun; child.arguments = [install.cli.path, "--no-open", "--port", String(address.port!)]
            child.environment = environment
            try evidence.redirect(child)
            try child.run(); launcher = child
            if evidence.directory != nil { evidence.log("APP-LAUNCHER pid \(child.processIdentifier)") }
        }
        let deadline = Date().addingTimeInterval(180)
        var exitDeadline: Date? = nil
        // Each distinct probe and listener observation is logged once, so a
        // start that never verifies names the guard that refused it.
        var observation = ""
        func observe(_ next: String) { if next != observation { observation = next; evidence.log(next) } }
        while Date() < min(deadline, exitDeadline ?? deadline) {
            guard !Task.isCancelled, generation == token else { return }
            // The CLI this app started is the launcher by identity while it runs.
            let own = launcher.flatMap { $0.isRunning ? Int($0.processIdentifier) : nil }
            let (result, observed) = await Server.inspect(home: home, environment: environment, install: install, address: address, launcher: own)
            guard !Task.isCancelled, generation == token else { return }
            if case .accessUnavailable(let version) = result { accessUnavailable(version); return }
            if case .ready(let key) = result {
                observe("PROBE ready \(observed)")
                let listener = await Server.listener(environment: environment, install: install, port: address.port!, launcher: own)
                guard !Task.isCancelled, generation == token else { return }
                if listener.verified {
                    evidence.log("LISTENER verified \(listener.description): \(listener.reason)")
                    ready(key: key, reused: false); return
                }
                evidence.log("LISTENER refused \(listener.description): \(listener.reason)")
                let blocks = await listenerBlocksStart(listener)
                guard !Task.isCancelled, generation == token else { return }
                if blocks { portBusy(listener); return }
            } else {
                if result == .busy {
                    let listener = await Server.listener(environment: environment, install: install, port: address.port!, launcher: own)
                    guard !Task.isCancelled, generation == token else { return }
                    observe("PROBE \(result.label) \(observed); LISTENER \(listener.verified ? "verified" : "refused") \(listener.description): \(listener.reason)")
                    let blocks = await listenerBlocksStart(listener)
                    guard !Task.isCancelled, generation == token else { return }
                    if blocks { portBusy(listener); return }
                } else { observe("PROBE \(result.label) \(observed)") }
            }
            if let launcher, !launcher.isRunning, exitDeadline == nil {
                exitDeadline = Date().addingTimeInterval(30)
                evidence.log("LAUNCHER exited \(launcher.terminationStatus)")
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        evidence.log("START timed out; last observation: \(observation.isEmpty ? "none" : observation)")
        throw LauncherError.message("start-failed")
    }
    func ready(key: String?, reused: Bool, monitorHealth: Bool = true) {
        state = "ready"; evidence.log("STATE \(reused ? "reused" : "ready")")
        window.contentView = web.view
        var url = URLComponents(url: address, resolvingAgainstBaseURL: false)!
        if let key { url.queryItems = [URLQueryItem(name: "k", value: key)] }
        pageURL = url.url!
        web.view.load(URLRequest(url: pageURL))
        evidence.capture(window, name: "ready")
        guard monitorHealth else { return }
        monitor = Task {
            var failures = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { return }
                let own = launcher.flatMap { $0.isRunning ? Int($0.processIdentifier) : nil }
                let result = await Server.probe(home: home, environment: environment, install: install, address: address, launcher: own)
                guard !Task.isCancelled else { return }
                if case .ready(let key) = result {
                    failures = 0
                    if state != "ready" {
                        state = "ready"; evidence.log("STATE recovered")
                        window.contentView = web.view
                        var url = URLComponents(url: address, resolvingAgainstBaseURL: false)!
                        if let key { url.queryItems = [URLQueryItem(name: "k", value: key)] }
                        pageURL = url.url!; web.view.load(URLRequest(url: pageURL))
                    }
                    continue
                }
                failures += 1
                if failures >= 2, case .accessUnavailable(let version) = result {
                    if state != "access-unavailable" { accessUnavailable(version) }
                } else if failures >= 2, state != "stopped" { show("stopped", actions: [("start", #selector(retry)), ("logs", #selector(logs))]) }
            }
        }
    }
    func failed(_ error: Error) {
        if Task.isCancelled { return }
        let key: String
        if case LauncherError.message(let value) = error { key = value } else { key = "operation-failed" }
        evidence.log("FAILURE \(key)")
        show("failed", message: text(key), actions: [("retry", #selector(retry)), ("logs", #selector(logs))])
    }
    @objc func installRuntime() {
        guard !busy else { return }; busy = true
        show("installing", actions: [("cancel", #selector(cancelInstall)), ("logs", #selector(logs))])
        let process = Process(); setup = process
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        let resources = Bundle.main.resourceURL!
        process.arguments = [resources.appendingPathComponent("setup-runtime.sh").path, Installations.runtime(home).path, resources.appendingPathComponent("runtime-manifest.json").path]
        process.environment = environment
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
        // Read complete lines, including when a multibyte character spans reads.
        let reader = pipe.fileHandleForReading
        process.terminationHandler = { [weak self] child in
            Task { @MainActor in
                guard let self else { return }
                self.setup = nil; self.busy = false
                if self.quittingAfterSetup { NSApp.reply(toApplicationShouldTerminate: true); return }
                if self.cancellingSetup {
                    self.cancellingSetup = false
                    self.show("stopped", actions: [("start", #selector(self.retry))]); return
                }
                if child.terminationStatus == 0 { self.begin() }
                else if self.state == "installing" { self.failed(LauncherError.message("install-failed")) }
            }
        }
        do {
            try process.run()
            Task.detached { [weak self] in
                var pending = Data()
                while true {
                    let bytes = reader.availableData
                    if bytes.isEmpty { break }
                    pending.append(bytes)
                    while let newline = pending.firstIndex(of: 10) {
                        let line = String(decoding: pending[..<newline], as: UTF8.self); pending.removeSubrange(...newline)
                        await MainActor.run {
                            self?.evidence.log(line)
                            for step in 1...3 where line.hasPrefix("SETUP \(step)/3") { self?.detail.stringValue = text("setup-step-\(step)") }
                        }
                    }
                    if pending.count > 65536 { pending.removeAll() }
                }
            }
        } catch { setup = nil; busy = false; failed(error) }
    }
    @objc func cancelInstall() {
        guard let setup, setup.isRunning, !cancellingSetup else { return }
        cancellingSetup = true; setup.terminate()
        presentCancellation()
    }
    @objc func retry() { begin() }
    @objc func stop() {
        guard !legacyInstallation, !busy, let install else { return }
        guard confirm("stop") else { return }
        busy = true; generation += 1; operation?.cancel(); monitor?.cancel()
        Task { defer { busy = false }
            do {
                let result = try await Server.run(install.bun.path, [install.cli.path, "stop", "--all"], environment: environment, timeout: 150)
                evidence.log(result.1)
                guard result.0 == 0 else { throw LauncherError.message("stop-failed") }
                let deadline = Date().addingTimeInterval(60)
                var free = false
                repeat {
                    free = await Server.probe(home: home, environment: environment, address: address) == .free
                    if free { break }
                    try await Task.sleep(nanoseconds: 500_000_000)
                } while Date() < deadline
                guard free else { throw LauncherError.message("stop-failed") }
                show("stopped", actions: [("start", #selector(retry))])
            } catch { failed(error) }
        }
    }
    @objc func toggleLogin() {
        guard !legacyInstallation, !busy, let install else { return }
        if install.service != nil {
            guard confirm("login") else { return }
        }
        busy = true
        let token = generation
        Task { defer { if generation == token { busy = false } }
            do {
                let args = install.service == nil ? ["service", "install", "--port", String(address.port!)] : ["service", "remove"]
                let result = try await Server.run(install.bun.path, [install.cli.path] + args, environment: environment, timeout: 150)
                evidence.log(result.1)
                guard result.0 == 0 else { throw LauncherError.message("service-failed") }
                if install.service != nil {
                    self.install = Installations.withoutService(install)
                    serviceMenu.state = .off; busy = false; begin(using: self.install)
                } else {
                    self.install = try Installations.discover(home); serviceMenu.state = .on
                }
            } catch { failed(error) }
        }
    }
    @objc func update() {
        if state == "ready" { web.view.evaluateJavaScript("window.dispatchEvent(new Event('llv:open-self-update'))", completionHandler: nil) }
        Task {
            do {
                guard let repository = Bundle.main.object(forInfoDictionaryKey: "DelegatusReleaseRepository") as? String,
                      repository.range(of: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", options: .regularExpression) != nil,
                      let url = URL(string: "https://api.github.com/repos/\(repository)/releases/latest") else { return }
                var request = URLRequest(url: url); request.timeoutInterval = 15
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], let tag = value["tag_name"] as? String,
                      let version = Version(String(tag.dropFirst())), let current = Version(manifest.delegatus.version), version > current,
                      let assets = value["assets"] as? [[String: Any]], let asset = assets.first(where: { $0["name"] as? String == "Delegatus-\(tag.dropFirst())-mac.dmg" }),
                      let link = asset["browser_download_url"] as? String, let download = URL(string: link), download.scheme == "https", download.host == "github.com" else { return }
                if confirm("update") { NSWorkspace.shared.open(download) }
            } catch { evidence.log("UPDATE check unavailable") }
        }
    }
    @objc func logs() { NSWorkspace.shared.activateFileViewerSelecting([evidence.logURL]) }
    @objc func about() { NSApp.orderFrontStandardAboutPanel(nil) }
    @objc func back() { web.view.goBack() }
    @objc func forward() { web.view.goForward() }
    @objc func reload() { web.view.reload() }
    @objc func openBrowser() { NSWorkspace.shared.open(pageURL) }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let setup, setup.isRunning { quittingAfterSetup = true; setup.terminate(); return .terminateLater }
        return confirm("quit") ? .terminateNow : .terminateCancel
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
}
