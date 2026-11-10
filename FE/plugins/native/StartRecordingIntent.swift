import AppIntents
import Foundation

// "Siri, PatPat 녹음 시작" — works from the side button (press and hold) and appears in the
// Shortcuts app, so the Action Button and Back Tap can run it too.
//
// The intent opens PatPat (iOS asks for Face ID/passcode first when the phone is locked) and leaves a
// time-stamped request file in the app's Documents folder. The JavaScript side reads and deletes it,
// then starts recording. A file is used instead of a link so a cold start cannot lose the request.
@available(iOS 16.0, *)
struct StartRecordingIntent: AppIntent {
  static var title: LocalizedStringResource = "녹음 시작"
  static var description = IntentDescription("PatPat을 열고 관찰 녹음을 바로 시작해요.")
  static var openAppWhenRun: Bool = true

  func perform() async throws -> some IntentResult {
    if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
      let request = documents.appendingPathComponent("patpat-start-request.txt")
      let seconds = String(Date().timeIntervalSince1970)
      try? seconds.write(to: request, atomically: true, encoding: .utf8)
    }
    return .result()
  }
}

@available(iOS 16.0, *)
struct PatPatShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartRecordingIntent(),
      phrases: [
        "\(.applicationName) 녹음 시작",
        "\(.applicationName)로 녹음 시작",
        "\(.applicationName) 녹음해 줘",
        "Start recording in \(.applicationName)",
      ],
      shortTitle: "녹음 시작",
      systemImageName: "mic.fill"
    )
  }
}
