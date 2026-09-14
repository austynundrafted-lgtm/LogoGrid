// LogoGrid — self-updater
//
// Checks the GitHub repository named in Info.plist (LogoGridUpdateRepository)
// for its latest release. When a newer version is published, the page shows an
// update card; installing downloads the release zip, verifies it (checksum,
// bundle identifier, version, code signature), swaps it in for the running
// app, and relaunches.

import AppKit
import CryptoKit
import Foundation

struct UpdateError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct ReleaseInfo {
    let version: String
    let notes: String
    let pageURL: String
    let downloadURL: URL
    let digest: String?
    let size: Int
}

@MainActor
final class Updater {
    private let skippedVersionKey = "LogoGridSkippedVersion"
    private let currentVersion: String
    private let repository: String?
    /// Sends { state, ... } to the page. States: available, current, installing, relaunching, error.
    private let report: ([String: Any]) -> Void
    private let onAvailabilityChange: (ReleaseInfo?) -> Void
    private(set) var available: ReleaseInfo?
    private var busy = false

    init(report: @escaping ([String: Any]) -> Void, onAvailabilityChange: @escaping (ReleaseInfo?) -> Void) {
        self.report = report
        self.onAvailabilityChange = onAvailabilityChange
        currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        repository = Bundle.main.object(forInfoDictionaryKey: "LogoGridUpdateRepository") as? String
    }

    // MARK: Checking

    func check(userInitiated: Bool) {
        guard !busy else { return }
        guard let endpoint = releaseEndpoint() else {
            if userInitiated { report(["state": "error", "message": "This build isn't set up for updates."]) }
            return
        }
        Task {
            do {
                let release = try await fetchLatest(endpoint)
                guard Updater.isVersion(release.version, newerThan: currentVersion) else {
                    available = nil
                    onAvailabilityChange(nil)
                    if userInitiated { report(["state": "current", "version": currentVersion]) }
                    return
                }
                available = release
                onAvailabilityChange(release)
                if !userInitiated && UserDefaults.standard.string(forKey: skippedVersionKey) == release.version { return }
                var payload: [String: Any] = [
                    "state": "available",
                    "version": release.version,
                    "currentVersion": currentVersion,
                    "notes": release.notes,
                    "size": release.size,
                    "pageURL": release.pageURL,
                ]
                if let reason = installBlockedReason() { payload["blockedReason"] = reason }
                report(payload)
            } catch {
                if userInitiated { report(["state": "error", "message": "Couldn't check for updates. \(error.localizedDescription)"]) }
            }
        }
    }

    func skip(version: String) {
        UserDefaults.standard.set(version, forKey: skippedVersionKey)
    }

    /// The releases API URL. `LOGOGRID_UPDATE_URL` overrides it (used to test updates against a local server).
    private func releaseEndpoint() -> URL? {
        if let override = ProcessInfo.processInfo.environment["LOGOGRID_UPDATE_URL"] { return URL(string: override) }
        guard let repository, !repository.isEmpty else { return nil }
        return URL(string: "https://api.github.com/repos/\(repository)/releases/latest")
    }

    private func fetchLatest(_ endpoint: URL) async throws -> ReleaseInfo {
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("LogoGrid/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { throw UpdateError("No releases have been published yet.") }
        guard status == 200 else { throw UpdateError("GitHub responded with status \(status).") }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              let assets = json["assets"] as? [[String: Any]],
              let asset = assets.first(where: { ($0["name"] as? String)?.hasSuffix(".zip") == true }),
              let urlString = asset["browser_download_url"] as? String,
              let downloadURL = URL(string: urlString)
        else { throw UpdateError("The latest release doesn't include an app download.") }

        var notes = json["body"] as? String ?? ""
        // Release pages carry install instructions for new users below this marker; the app hides them.
        if let marker = notes.range(of: "<!-- install -->") { notes = String(notes[..<marker.lowerBound]) }

        return ReleaseInfo(
            version: tag.hasPrefix("v") ? String(tag.dropFirst()) : tag,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines),
            pageURL: json["html_url"] as? String ?? "",
            downloadURL: downloadURL,
            digest: asset["digest"] as? String,
            size: asset["size"] as? Int ?? 0
        )
    }

    static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let b = current.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: Installing

    /// Why the running copy can't replace itself, if it can't.
    func installBlockedReason() -> String? {
        let path = Bundle.main.bundleURL.path
        if path.contains("/AppTranslocation/") || path.hasPrefix("/Volumes/") {
            return "Move LogoGrid into your Applications folder and open it from there to install updates."
        }
        let parent = Bundle.main.bundleURL.deletingLastPathComponent().path
        if !FileManager.default.isWritableFile(atPath: parent) {
            return "LogoGrid can't update itself in \(parent). Move it to your Applications folder."
        }
        return nil
    }

    func install() {
        guard let release = available, !busy else { return }
        if let reason = installBlockedReason() {
            report(["state": "error", "message": reason])
            return
        }
        busy = true
        report(["state": "installing", "version": release.version])
        Task {
            do {
                let appURL = Bundle.main.bundleURL
                try await downloadAndReplace(release, at: appURL)
                report(["state": "relaunching", "version": release.version])
                relaunch(appURL)
            } catch {
                busy = false
                report(["state": "error", "message": "The update couldn't be installed. \(error.localizedDescription)"])
            }
        }
    }

    private func downloadAndReplace(_ release: ReleaseInfo, at appURL: URL) async throws {
        let fm = FileManager.default
        // A scratch folder on the same volume as the app, so the final swap is a move, not a copy.
        let work = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: appURL, create: true)
        defer { try? fm.removeItem(at: work) }

        let (downloaded, response) = try await URLSession.shared.download(from: release.downloadURL)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError("The download failed.") }
        let zip = work.appendingPathComponent("update.zip")
        try fm.moveItem(at: downloaded, to: zip)

        if let digest = release.digest, digest.hasPrefix("sha256:") {
            let hash = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
            guard "sha256:\(hash)" == digest else { throw UpdateError("The download didn't match the release checksum.") }
        }

        let unpacked = work.appendingPathComponent("unpacked")
        try await run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])
        guard let newApp = try fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)
            .first(where: { $0.pathExtension == "app" })
        else { throw UpdateError("The download doesn't contain an app.") }

        let info = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else {
            throw UpdateError("The download isn't LogoGrid.")
        }
        guard let newVersion = info?["CFBundleShortVersionString"] as? String,
              Updater.isVersion(newVersion, newerThan: currentVersion)
        else { throw UpdateError("The download isn't a newer version.") }

        try await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp.path])
        try? await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp.path])

        _ = try fm.replaceItemAt(appURL, withItemAt: newApp)
    }

    private func run(_ tool: String, _ arguments: [String]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { finished in
                if finished.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: UpdateError("\(URL(fileURLWithPath: tool).lastPathComponent) failed."))
                }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }

    /// Waits for this process to exit, then opens the (now updated) app again.
    private func relaunch(_ appURL: URL) {
        let pid = ProcessInfo.processInfo.processIdentifier
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"$2\"", "sh", "\(pid)", appURL.path]
        try? process.run()
        NSApp.terminate(nil)
    }
}
