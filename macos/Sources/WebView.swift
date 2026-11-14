import AppKit
import WebKit

@MainActor final class Browser: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let view: WKWebView
    let evidence: Evidence
    unowned let window: NSWindow
    let port: Int
    private var pageCapture: Task<Void, Never>?
    init(evidence: Evidence, window: NSWindow, port: Int = 8898) {
        self.evidence = evidence; self.window = window; self.port = port
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 780), configuration: configuration)
        super.init()
        view.navigationDelegate = self; view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
    }
    func local(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.user == nil && url.password == nil
    }
    func external(_ url: URL?) {
        guard let url, ["https", "http", "mailto"].contains(url.scheme ?? ""), url.user == nil, url.password == nil else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if local(action.request.url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else { external(action.request.url); decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if local(action.request.url) { webView.load(action.request) } else { external(action.request.url) }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageCapture?.cancel()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard local(webView.url) else { return }
        webView.evaluateJavaScript("({language:navigator.language,ready:document.readyState})") { [weak self] result, _ in
            guard let self, let result = result as? [String: String] else { return }
            self.evidence.log("WEB language=\(result["language"] ?? "?") ready=\(result["ready"] ?? "?")")
            self.captureFinishedPage(webView)
        }
    }
    private func captureFinishedPage(_ webView: WKWebView) {
        guard evidence.directory != nil else { return }
        pageCapture?.cancel()
        pageCapture = Task { @MainActor in
            guard let resource = Bundle.main.url(forResource: "page-readiness", withExtension: "js"),
                  let script = try? String(contentsOf: resource, encoding: .utf8) else {
                evidence.log("PAGE failed: readiness probe unavailable"); return
            }
            let deadline = Date().addingTimeInterval(60)
            var previous = ""
            while !Task.isCancelled && Date() < deadline && local(webView.url) {
                let state = (try? await webView.evaluateJavaScript(script)) as? String ?? "probe-error"
                guard !Task.isCancelled && local(webView.url) else { return }
                if state != previous { evidence.log("PAGE state=\(state)"); previous = state }
                if state == "finished" {
                    // Let content paint, then recheck immediately before the PNG
                    // write instead of accepting a delayed loading-shell frame.
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    guard !Task.isCancelled && local(webView.url) else { return }
                    let painted = (try? await webView.evaluateJavaScript(script)) as? String
                    guard !Task.isCancelled && local(webView.url) else { return }
                    if painted == "finished" {
                        evidence.capture(window, name: "page", delay: 0)
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            guard !Task.isCancelled else { return }
            let lastState = previous
            evidence.capture(window, name: "page-loading") {
                self.evidence.log("PAGE failed: \(lastState)")
            }
        }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard local(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == port && local(frame.request.url) && type == .microphone ? .prompt : .deny)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: text("ok")); alert.addButton(withTitle: text("cancel"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); input.stringValue = defaultText ?? ""; alert.accessoryView = input
        alert.addButton(withTitle: text("ok")); alert.addButton(withTitle: text("cancel"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
    }
}
