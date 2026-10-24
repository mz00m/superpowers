import Foundation

/// One line of text that Vision found in the photo.
struct RecognizedLine: Identifiable, Equatable {
    let id = UUID()
    let text: String
}

/// The network name and password the user has confirmed.
struct WiFiCredentials: Equatable {
    var ssid = ""
    var password = ""

    var trimmedSSID: String { ssid.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedPassword: String { password.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Why the network name can't be used, or nil. Empty is not reported as a problem.
    var ssidProblem: String? {
        if trimmedSSID.utf8.count > 32 {
            return "Network names are at most 32 bytes. Check for extra text."
        }
        return nil
    }

    /// Why the password can't be used for a WPA/WPA2/WPA3 network, or nil.
    /// Empty is not reported as a problem.
    var passwordProblem: String? {
        let value = trimmedPassword
        if value.isEmpty { return nil }
        // A 64-character hex string is a raw WPA key rather than a passphrase.
        if value.count == 64, value.allSatisfy(\.isHexDigit) { return nil }
        if !value.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 && $0.value < 0x7F }) {
            return "Wi-Fi passwords use only standard ASCII characters. A character may have been misread."
        }
        if value.count < 8 {
            return "Wi-Fi passwords are at least 8 characters. Check for missed characters."
        }
        if value.count > 63 {
            return "Wi-Fi passwords are at most 63 characters. Check for extra text."
        }
        return nil
    }

    var canJoin: Bool {
        !trimmedSSID.isEmpty && !trimmedPassword.isEmpty && ssidProblem == nil && passwordProblem == nil
    }

    // MARK: - Label stripping

    private static let labels = [
        "wi-fi network name", "wifi network name", "network name", "wi-fi name", "wifi name",
        "wi-fi network", "wifi network", "wi-fi", "wifi", "wlan", "network", "ssid", "name",
        "wi-fi password", "wifi password", "password", "passphrase", "passcode", "pass", "pwd",
        "network key", "security key", "wpa2 key", "wpa key", "key",
    ]

    /// Matches a known label at the start of a line, followed by a separator such as ":".
    /// The separator is required so a password like "Passw0rd!" keeps its first letters.
    private static let labelPattern: NSRegularExpression = {
        let alternatives = labels
            .sorted { $0.count > $1.count }
            .map { NSRegularExpression.escapedPattern(for: $0).replacingOccurrences(of: " ", with: "\\s*") }
            .joined(separator: "|")
        let pattern = "^\\s*(?:\(alternatives))\\s*[:：=]\\s*"
        // The pattern is built from constants above, so this cannot fail at runtime.
        return try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }()

    /// Removes a leading label such as "SSID:" or "Password:" and surrounding whitespace.
    static func strippingLabel(from line: String) -> String {
        let range = NSRange(line.startIndex..., in: line)
        let stripped = labelPattern.stringByReplacingMatches(in: line, range: range, withTemplate: "")
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
