// LogoGrid — native macOS shell
//
// A single window hosting the web UI in WKWebView. The page talks to this
// shell through the "native" message handler for things a web page can't do
// well on its own: open/save panels, the clipboard, and persistent settings.

import Cocoa
import UniformTypeIdentifiers
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let prefsKey = "LogoGridPrefs"
    private var window: NSWindow!
    private var webView: WKWebView!
    private var webRoot: URL!
    private var pageReady = false
    private var pendingFiles: [URL] = []
    private var updater: Updater!
    private var updateMenuItem: NSMenuItem!
    private var checkedForUpdatesAtLaunch = false

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        updater = Updater(
            report: { [weak self] payload in self?.sendUpdateStatus(payload) },
            onAvailabilityChange: { [weak self] release in
                self?.updateMenuItem.title = release.map { "Install LogoGrid \($0.version) and Relaunch…" } ?? "Check for Updates…"
            }
        )
        buildMenu()

        webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

        let contentController = WKUserContentController()
        contentController.add(WeakMessageHandler(self), name: "native")
        contentController.addUserScript(WKUserScript(source: bootScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let config = WKWebViewConfiguration()
        config.userContentController = contentController

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsMagnification = false
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LogoGrid"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("LogoGridMainWindow")
        window.makeKeyAndOrderFront(nil)

        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        if pageReady { loadFile(url) } else { pendingFiles = [url] }
    }

    private func bootScript() -> String {
        var prefs = "null"
        if let stored = UserDefaults.standard.string(forKey: prefsKey),
           let data = stored.data(using: .utf8),
           (try? JSONSerialization.jsonObject(with: data)) != nil {
            prefs = stored
        }
        return "window.__LOGOGRID_BOOT__ = { native: true, version: \(jsString(version)), prefs: \(prefs) };"
    }

    // MARK: Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "ready":
            pageReady = true
            let files = pendingFiles
            pendingFiles = []
            files.forEach(loadFile)
            if !checkedForUpdatesAtLaunch {
                checkedForUpdatesAtLaunch = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.updater.check(userInitiated: false) }
            }
        case "checkUpdates":
            updater.check(userInitiated: true)
        case "installUpdate":
            updater.install()
        case "skipUpdate":
            if let version = body["version"] as? String { updater.skip(version: version) }
        case "open":
            showOpenPanel()
        case "save":
            guard let name = body["name"] as? String, let data = body["data"] as? String else { return }
            save(name: name, ext: body["ext"] as? String ?? "svg", data: data, base64: (body["encoding"] as? String) == "base64")
        case "copy":
            guard let text = body["text"] as? String else { return }
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
            pb.setData(Data(text.utf8), forType: NSPasteboard.PasteboardType("public.svg-image"))
            callJS("window.LogoGrid.toast(\"SVG copied to clipboard\")")
        case "prefs":
            if let json = body["json"] as? String { UserDefaults.standard.set(json, forKey: prefsKey) }
        case "title":
            if let title = body["title"] as? String { window.title = title }
        default:
            break
        }
    }

    private func sendUpdateStatus(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        callJS("window.LogoGrid.updateStatus(\(json))")
    }

    @objc private func updateMenuAction(_ sender: Any?) {
        if updater.available != nil { updater.install() } else { updater.check(userInitiated: true) }
    }

    private func callJS(_ source: String) {
        webView.evaluateJavaScript(source, completionHandler: nil)
    }

    private func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    // MARK: Files

    @objc func openDocument(_ sender: Any?) { showOpenPanel() }

    private func showOpenPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.svg]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a logo SVG. From Illustrator: File › Export › Export As… › SVG."
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.loadFile(url)
        }
    }

    private func loadFile(_ url: URL) {
        guard let data = try? Data(contentsOf: url) else {
            callJS("window.LogoGrid.toast(\(jsString("Couldn't read \(url.lastPathComponent)")), true)")
            return
        }
        let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        callJS("window.LogoGrid.loadSVG(\(jsString(text)), \(jsString(url.lastPathComponent)))")
        NSDocumentController.shared.noteNewRecentDocumentURL(url)
    }

    private func save(name: String, ext: String, data: String, base64: Bool) {
        let bytes: Data? = base64 ? Data(base64Encoded: data) : Data(data.utf8)
        guard let bytes else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        if let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            do {
                try bytes.write(to: url, options: .atomic)
                self.callJS("window.LogoGrid.toast(\(self.jsString("Saved \(url.lastPathComponent)")))")
            } catch {
                self.callJS("window.LogoGrid.toast(\(self.jsString("Couldn't save: \(error.localizedDescription)")), true)")
            }
        }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL && url.standardizedFileURL.path.hasPrefix(webRoot.standardizedFileURL.path) {
            decisionHandler(.allow)
        } else if url.isFileURL {
            // A file dropped outside the page's drop handler — load it instead of navigating away.
            decisionHandler(.cancel)
            loadFile(url)
        } else if url.scheme == "http" || url.scheme == "https" {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
        } else {
            decisionHandler(url.scheme == "about" ? .allow : .cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        webView.reload()
    }

    // MARK: Menu

    @objc private func exportSVG(_ sender: Any?) { callJS("window.LogoGrid.exportSVG()") }
    @objc private func exportPNG(_ sender: Any?) { callJS("window.LogoGrid.exportPNG()") }
    @objc private func copySVG(_ sender: Any?) { callJS("window.LogoGrid.copySVG()") }
    @objc private func showAbout(_ sender: Any?) { callJS("window.LogoGrid.showAbout()") }
    @objc private func zoomIn(_ sender: Any?) { callJS("window.LogoGrid.zoomIn()") }
    @objc private func zoomOut(_ sender: Any?) { callJS("window.LogoGrid.zoomOut()") }
    @objc private func zoomFit(_ sender: Any?) { callJS("window.LogoGrid.zoomFit()") }

    private func buildMenu() {
        let main = NSMenu()
        updateMenuItem = NSMenuItem(title: "Check for Updates…", action: #selector(updateMenuAction(_:)), keyEquivalent: "")

        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
            menuItem.keyEquivalentModifierMask = modifiers
            return menuItem
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            let host = NSMenuItem()
            host.submenu = menu
            main.addItem(host)
            return menu
        }

        _ = submenu("LogoGrid", [
            item("About LogoGrid", #selector(showAbout(_:))),
            updateMenuItem,
            .separator(),
            item("Hide LogoGrid", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit LogoGrid", #selector(NSApplication.terminate(_:)), "q"),
        ])

        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "Open Recent")
        recentMenu.addItem(item("Clear Menu", #selector(NSDocumentController.clearRecentDocuments(_:))))
        recentItem.submenu = recentMenu

        _ = submenu("File", [
            item("Open…", #selector(openDocument(_:)), "o"),
            recentItem,
            .separator(),
            item("Export SVG…", #selector(exportSVG(_:)), "e"),
            item("Export PNG…", #selector(exportPNG(_:)), "e", [.command, .shift]),
            item("Copy SVG", #selector(copySVG(_:)), "c", [.command, .shift]),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])

        _ = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])

        _ = submenu("View", [
            item("Zoom In", #selector(zoomIn(_:)), "="),
            item("Zoom Out", #selector(zoomOut(_:)), "-"),
            item("Zoom to Fit", #selector(zoomFit(_:)), "0"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])

        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
        ])

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

// WKUserContentController retains its handlers; this avoids a retain cycle.
@MainActor
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
