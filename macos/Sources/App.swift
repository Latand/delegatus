import AppKit
import WebKit

func text(_ key: String) -> String { NSLocalizedString(key, comment: "") }

@main @MainActor final class App: NSObject, NSApplicationDelegate, NSToolbarDelegate {
    static func main() {
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
    var serviceMenu: NSMenuItem!
    var generation = 0
    var busy = false
    var quittingAfterSetup = false
    var environment: [String: String] { Installations.childEnvironment(home: home, install: install, language: language) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            evidence = try Evidence(home: home)
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
        window = NSWindow(contentRect: NSRect(origin: .zero, size: initialSize), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Delegatus"; window.minSize = NSSize(width: 680, height: 500); window.center()
        window.isReleasedWhenClosed = false
        web = Browser(evidence: evidence, window: window)
        let toolbar = NSToolbar(identifier: "navigation"); toolbar.delegate = self
        window.toolbar = toolbar
        buildMenus()
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if evidence.directory != nil && CommandLine.arguments.contains("--evidence-error") {
            failed(LauncherError.message("install-failed")); return
        }
        begin()
    }
    func item(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: text(title), action: action, keyEquivalent: key); item.target = self; menu.addItem(item); return item
    }
    func buildMenus() {
        let main = NSMenu(); NSApp.mainMenu = main
        let application = NSMenu(); let root = NSMenuItem(); root.title = "Delegatus"; root.submenu = application; main.addItem(root)
        _ = item(application, "about", #selector(about))
        _ = item(application, "update", #selector(update))
        serviceMenu = item(application, "login", #selector(toggleLogin))
        application.addItem(.separator())
        _ = item(application, "start", #selector(retry))
        _ = item(application, "stop", #selector(stop))
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
        for (label, action) in actions { let button = NSButton(title: text(label), target: self, action: action); button.bezelStyle = .rounded; buttons.addArrangedSubview(button) }
        let stack = NSStackView(views: [icon, title, detail, buttons]); stack.orientation = .vertical; stack.spacing = 22; stack.translatesAutoresizingMaskIntoConstraints = false
        status.addSubview(stack); window.contentView = status
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: status.centerXAnchor), stack.centerYAnchor.constraint(equalTo: status.centerYAnchor), stack.widthAnchor.constraint(equalToConstant: 560)])
        status.layoutSubtreeIfNeeded(); window.displayIfNeeded(); evidence.capture(window, name: next)
    }
    func begin(using retainedInstall: Installation? = nil) {
        guard !busy else { return }
        generation += 1; let token = generation
        operation?.cancel(); monitor?.cancel()
        busy = true
        operation = Task { defer { if generation == token && setup == nil { busy = false } }
            do {
                install = try (retainedInstall ?? Installations.discover(home))
                serviceMenu.state = install?.service == nil ? .off : .on
                let probe = await Server.probe(home: home, environment: environment, install: install)
                guard !Task.isCancelled, generation == token else { return }
                if case .ready(let key) = probe {
                    let listener = await Server.listener(environment: environment, install: install)
                    guard !Task.isCancelled, generation == token else { return }
                    if listener.verified { ready(key: key, reused: true); return }
                    portBusy(listener); return
                }
                if probe == .busy || probe == .waiting { portBusy(await Server.listener(environment: environment)); return }
                guard let install else {
                    let mb = (manifest.bun.arm64.bytes + manifest.delegatus.bytes) / 1_000_000
                    show("needs-install", message: String(format: text("install-question"), manifest.bun.version, manifest.delegatus.version, mb), actions: [("install", #selector(installRuntime)), ("quit", #selector(quit))])
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
            } catch { failed(error) }
        }
    }
    func portBusy(_ listener: (owned: Bool, description: String)) {
        show("port-busy", message: listener.owned ? String(format: text("port-owner"), listener.description) : text("port-other-user"), actions: [("retry", #selector(retry)), ("logs", #selector(logs))])
    }
    func start(_ install: Installation, token: Int) async throws {
        show("starting")
        if let plist = install.service { try await Server.startService(plist, environment: environment) }
        else {
            let child = Process(); child.executableURL = install.bun; child.arguments = [install.cli.path, "--no-open", "--port", "8898"]
            child.environment = environment
            try evidence.redirect(child)
            try child.run(); launcher = child
        }
        let deadline = Date().addingTimeInterval(180)
        var exitDeadline: Date? = nil
        while Date() < min(deadline, exitDeadline ?? deadline) {
            guard !Task.isCancelled, generation == token else { return }
            let result = await Server.probe(home: home, environment: environment, install: install)
            guard !Task.isCancelled, generation == token else { return }
            if case .ready(let key) = result {
                let listener = await Server.listener(environment: environment, install: install)
                guard !Task.isCancelled, generation == token else { return }
                if listener.verified { ready(key: key, reused: false); return }
            }
            if let launcher, !launcher.isRunning, exitDeadline == nil { exitDeadline = Date().addingTimeInterval(30) }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw LauncherError.message("start-failed")
    }
    func ready(key: String?, reused: Bool) {
        state = "ready"; evidence.log("STATE \(reused ? "reused" : "ready")")
        window.contentView = web.view
        var url = URLComponents(url: Server.address, resolvingAgainstBaseURL: false)!
        if let key { url.queryItems = [URLQueryItem(name: "k", value: key)] }
        pageURL = url.url!
        web.view.load(URLRequest(url: pageURL))
        monitor = Task {
            var failures = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { return }
                let result = await Server.probe(home: home, environment: environment, install: install)
                guard !Task.isCancelled else { return }
                if case .ready(let key) = result {
                    failures = 0
                    if state != "ready" {
                        state = "ready"; evidence.log("STATE recovered")
                        window.contentView = web.view
                        var url = URLComponents(url: Server.address, resolvingAgainstBaseURL: false)!
                        if let key { url.queryItems = [URLQueryItem(name: "k", value: key)] }
                        pageURL = url.url!; web.view.load(URLRequest(url: pageURL))
                    }
                    continue
                }
                failures += 1
                if failures == 2 { show("stopped", actions: [("start", #selector(retry)), ("logs", #selector(logs))]) }
            }
        }
    }
    func failed(_ error: Error) {
        if Task.isCancelled { return }
        let key: String
        if case LauncherError.message(let value) = error { key = value } else { key = "operation-failed" }
        let log = install?.service == nil ? evidence.tail() : evidence.tail(home.appendingPathComponent("Library/Logs/Delegatus/server.log"))
        show("failed", message: text(key) + (log.isEmpty ? "" : "\n\n" + String(log.suffix(1200))), actions: [("retry", #selector(retry)), ("logs", #selector(logs))])
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
    @objc func cancelInstall() { setup?.terminate(); show("stopped", actions: [("start", #selector(retry))]) }
    @objc func retry() { begin() }
    @objc func stop() {
        guard !busy, let install else { return }
        let alert = NSAlert(); alert.messageText = text("stop-question"); alert.informativeText = text("stop-warning")
        alert.addButton(withTitle: text("stop")); alert.addButton(withTitle: text("cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        busy = true; generation += 1; operation?.cancel(); monitor?.cancel()
        Task { defer { busy = false }
            do {
                let result = try await Server.run(install.bun.path, [install.cli.path, "stop", "--all"], environment: environment, timeout: 150)
                evidence.log(result.1)
                guard result.0 == 0 else { throw LauncherError.message("stop-failed") }
                let deadline = Date().addingTimeInterval(60)
                var free = false
                repeat {
                    free = await Server.probe(home: home, environment: environment) == .free
                    if free { break }
                    try await Task.sleep(nanoseconds: 500_000_000)
                } while Date() < deadline
                guard free else { throw LauncherError.message("stop-failed") }
                show("stopped", actions: [("start", #selector(retry))])
            } catch { failed(error) }
        }
    }
    @objc func toggleLogin() {
        guard !busy, let install else { return }
        if install.service != nil {
            let alert = NSAlert(); alert.messageText = text("login-remove-question")
            alert.addButton(withTitle: text("ok")); alert.addButton(withTitle: text("cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        busy = true
        let token = generation
        Task { defer { if generation == token { busy = false } }
            do {
                let args = install.service == nil ? ["service", "install", "--port", "8898"] : ["service", "remove"]
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
                let alert = NSAlert(); alert.messageText = text("app-update"); alert.addButton(withTitle: text("download")); alert.addButton(withTitle: text("cancel"))
                if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(download) }
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
        let alert = NSAlert(); alert.messageText = text("quit-question"); alert.informativeText = text("quit-detail")
        alert.addButton(withTitle: text("keep-running")); alert.addButton(withTitle: text("cancel"))
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
}
