import AppKit
import WebKit

@MainActor final class Browser: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let view: WKWebView
    let evidence: Evidence
    unowned let window: NSWindow
    init(evidence: Evidence, window: NSWindow) {
        self.evidence = evidence; self.window = window
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 780), configuration: configuration)
        super.init()
        view.navigationDelegate = self; view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
    }
    static func local(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == 8898 && url.user == nil && url.password == nil
    }
    func external(_ url: URL?) {
        guard let url, ["https", "http", "mailto"].contains(url.scheme ?? ""), url.user == nil, url.password == nil else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if Self.local(action.request.url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else { external(action.request.url); decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if Self.local(action.request.url) { webView.load(action.request) } else { external(action.request.url) }
        return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard Self.local(webView.url) else { return }
        webView.evaluateJavaScript("({language:navigator.language,ready:document.readyState})") { [weak self] result, _ in
            guard let self, let result = result as? [String: String] else { return }
            self.evidence.log("WEB language=\(result["language"] ?? "?") ready=\(result["ready"] ?? "?")")
            // Snapshot after the React shell has painted, without granting native authority to JS.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self.evidence.capture(webView, name: "page")
            }
        }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard Self.local(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == 8898 && Self.local(frame.request.url) && type == .microphone ? .prompt : .deny)
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
