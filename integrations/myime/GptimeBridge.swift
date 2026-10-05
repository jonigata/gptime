import Foundation
import Dispatch
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The ordinary ConvertText ABI remains local-only. Mozc calls this entry point
// only for explicit conversion, never for predictions or private input.
private struct GptimeConfiguration: Decodable {
    let endpoint: String
    let token: String
}

private final class GptimeReply: @unchecked Sendable {
    let lock = NSLock()
    private var value: String?
    func set(_ text: String?) { lock.lock(); defer { lock.unlock() }; value = text }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
}

private func gptimeCandidate(_ reading: String) -> String? {
    guard !reading.isEmpty, reading.count <= 128,
          let localAppData = ProcessInfo.processInfo.environment["LOCALAPPDATA"] else { return nil }
    let configURL = URL(fileURLWithPath: localAppData).appendingPathComponent("GPTIME/bridge.json")
    guard let data = try? Data(contentsOf: configURL),
          let config = try? JSONDecoder().decode(GptimeConfiguration.self, from: data),
          let url = URL(string: config.endpoint), url.scheme == "http", url.host == "127.0.0.1",
          url.port == 18765, url.path == "/convert", url.user == nil, url.password == nil,
          config.token.count == 64 else { return nil }

    var request = URLRequest(url: url, timeoutInterval: 1.3)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["reading": reading])
    let reply = GptimeReply()
    let ready = DispatchSemaphore(value: 0)
    let task = URLSession.shared.dataTask(with: request) { data, response, error in
        defer { ready.signal() }
        guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
              let data = data, data.count < 16384,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = object["text"] as? String, !text.isEmpty, text.count <= 1024,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return }
        reply.set(text)
    }
    task.resume()
    if ready.wait(timeout: .now() + 1.3) == .timedOut { task.cancel(); return nil }
    return reply.get()
}

@_cdecl("ConvertTextWithLuna")
public func convertTextWithLuna(_ key: UnsafePointer<CChar>?, _ allowLearning: Int32) -> UnsafePointer<CChar>? {
    // First get dictionary candidates using the existing, internally locked API.
    guard let local = convertText(key, allowLearning) else { return nil }
    guard allowLearning != 0, let key = key else { return local }
    let reading = String(cString: key)
    // No engineLock is held while waiting for the bridge.
    guard let cloud = gptimeCandidate(reading),
          let bytes = String(cString: local).data(using: .utf8),
          var candidates = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]] else { return local }
    candidates.removeAll { ($0["text"] as? String) == cloud }
    candidates.insert(["text": cloud, "correspondingCount": reading.count], at: 0)
    guard let encoded = try? JSONSerialization.data(withJSONObject: candidates),
          let json = String(data: encoded, encoding: .utf8) else { return local }
    freeString(local)
    return UnsafePointer(_strdup(json))
}
