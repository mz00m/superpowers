import NetworkExtension
import PhotosUI
import SwiftUI
import Vision

@MainActor
final class ScanViewModel: ObservableObject {
    enum Field: Hashable {
        case ssid, password
    }

    enum JoinState: Equatable {
        case idle
        case joining
        /// iOS reports the device is on this network.
        case joined(ssid: String)
        /// iOS accepted the configuration but the device did not end up on the network.
        case unconfirmed(ssid: String)
        case failed(message: String)
    }

    @Published private(set) var image: UIImage?
    @Published private(set) var lines: [RecognizedLine] = []
    @Published private(set) var isRecognizing = false
    @Published private(set) var recognitionError: String?
    @Published private(set) var joinState: JoinState = .idle

    /// Which field the next tapped line fills.
    @Published var nextField: Field = .ssid

    @Published var credentials = WiFiCredentials() {
        didSet {
            // Editing after a result clears the stale result.
            if joinState != .joining, credentials != oldValue { joinState = .idle }
        }
    }

    /// Identifies the latest recognition so an older, slower one can't overwrite its results.
    private var recognitionID = UUID()

    // MARK: - Recognition

    func loadPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                showLoadFailure()
                return
            }
            await recognize(image)
        } catch {
            showLoadFailure()
        }
    }

    func recognize(_ image: UIImage) async {
        let id = UUID()
        recognitionID = id
        self.image = image
        lines = []
        recognitionError = nil
        credentials = WiFiCredentials()
        nextField = .ssid
        isRecognizing = true

        let result: Result<[String], Error>
        do {
            result = .success(try await Self.recognizeText(in: image))
        } catch {
            result = .failure(error)
        }

        guard recognitionID == id else { return }
        isRecognizing = false
        switch result {
        case .success(let texts):
            lines = texts.map { RecognizedLine(text: $0) }
            if lines.isEmpty {
                recognitionError = "No text found. Try a closer, sharper photo with even lighting."
            }
        case .failure(let error):
            recognitionError = "Couldn't read text from the photo: \(error.localizedDescription)"
        }
    }

    private func showLoadFailure() {
        recognitionID = UUID()
        isRecognizing = false
        recognitionError = "Couldn't load that photo. Try another one."
    }

    private nonisolated static func recognizeText(in image: UIImage) async throws -> [String] {
        guard let cgImage = image.cgImage else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                // Passwords are not dictionary words, so don't let Vision "correct" them.
                request.usesLanguageCorrection = false

                let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation)
                do {
                    try handler.perform([request])
                    let texts = (request.results ?? [])
                        .compactMap { $0.topCandidates(1).first?.string }
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    continuation.resume(returning: texts)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // MARK: - Selecting fields

    func use(_ line: RecognizedLine) {
        let value = WiFiCredentials.strippingLabel(from: line.text)
        switch nextField {
        case .ssid:
            credentials.ssid = value
            nextField = .password
        case .password:
            credentials.password = value
        }
    }

    /// Which field, if any, currently holds this line's text.
    func field(for line: RecognizedLine) -> Field? {
        let value = WiFiCredentials.strippingLabel(from: line.text)
        guard !value.isEmpty else { return nil }
        if value == credentials.trimmedSSID { return .ssid }
        if value == credentials.trimmedPassword { return .password }
        return nil
    }

    // MARK: - Joining

    func join() async {
        if let problem = credentials.ssidProblem ?? credentials.passwordProblem {
            joinState = .failed(message: problem)
            return
        }
        let ssid = credentials.trimmedSSID
        let password = credentials.trimmedPassword
        guard !ssid.isEmpty, !password.isEmpty else {
            joinState = .failed(message: "Enter both a network name and a password.")
            return
        }

        let configuration = NEHotspotConfiguration(ssid: ssid, passphrase: password, isWEP: false)
        configuration.joinOnce = false

        joinState = .joining
        do {
            try await NEHotspotConfigurationManager.shared.apply(configuration)
        } catch {
            let nsError = error as NSError
            if nsError.domain == NEHotspotConfigurationErrorDomain,
               nsError.code == NEHotspotConfigurationError.alreadyAssociated.rawValue {
                joinState = .joined(ssid: ssid)
            } else {
                joinState = .failed(message: Self.message(for: nsError))
            }
            return
        }

        // apply() often succeeds even when the network is out of range or the password
        // is wrong, so check which network the device actually ended up on.
        joinState = await Self.isConnected(to: ssid) ? .joined(ssid: ssid) : .unconfirmed(ssid: ssid)
    }

    private static func isConnected(to ssid: String) async -> Bool {
        for attempt in 0..<5 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            if let network = await NEHotspotNetwork.fetchCurrent(), network.ssid == ssid {
                return true
            }
        }
        return false
    }

    private static func message(for error: NSError) -> String {
        guard error.domain == NEHotspotConfigurationErrorDomain else {
            return error.localizedDescription
        }
        switch NEHotspotConfigurationError(rawValue: error.code) {
        case .userDenied:
            return "You declined to join the network."
        case .invalidSSID:
            return "The network name isn't valid."
        case .invalidWPAPassphrase:
            return "The password isn't valid. Wi-Fi passwords are 8 to 63 characters."
        case .pending:
            return "Another join request is still in progress. Try again in a moment."
        case .applicationIsNotInForeground:
            return "Keep the app open while joining."
        case .systemConfiguration:
            return "This network can't be changed because it was set up by a configuration profile."
        case .internal:
            return "iOS couldn't join the network. It may be out of range, or the password may be wrong."
        default:
            return "Couldn't join the network (error \(error.code)): \(error.localizedDescription)"
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
