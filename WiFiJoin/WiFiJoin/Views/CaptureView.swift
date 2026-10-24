import PhotosUI
import SwiftUI

struct CaptureView: View {
    @StateObject private var model = ScanViewModel()
    @State private var photoItem: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var cameraAlert: CameraAccess.Status?
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                credentialsSection
                joinSection
                photoSection
                linesSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("WiFiJoin")
        }
        .onChange(of: photoItem) { item in
            guard let item else { return }
            photoItem = nil  // Lets the user pick the same photo again.
            Task { await model.loadPhoto(item) }
        }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { image in
                Task { await model.recognize(image) }
            }
            .ignoresSafeArea()
        }
        .alert(
            cameraAlert == .unavailable ? "No Camera" : "Camera Access Needed",
            isPresented: Binding(get: { cameraAlert != nil }, set: { if !$0 { cameraAlert = nil } })
        ) {
            if cameraAlert == .denied {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            }
            Button("OK", role: .cancel) {}
        } message: {
            if cameraAlert == .unavailable {
                Text("This device has no camera. Choose a photo instead.")
            } else {
                Text("Allow camera access in Settings to photograph a Wi-Fi card, or choose a photo instead.")
            }
        }
    }

    // MARK: - Sections

    private var credentialsSection: some View {
        Section {
            LabeledContent("Network") {
                TextField("Network name (SSID)", text: $model.credentials.ssid)
                    .credentialFieldStyle()
            }
            LabeledContent("Password") {
                TextField("Password", text: $model.credentials.password)
                    .credentialFieldStyle()
            }
        } header: {
            Text("Join This Network")
        } footer: {
            if let problem = model.credentials.ssidProblem ?? model.credentials.passwordProblem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            } else {
                Text("Check both fields against the card. You can edit them before joining.")
            }
        }
    }

    private var joinSection: some View {
        Section {
            Button {
                Task { await model.join() }
            } label: {
                HStack {
                    Spacer()
                    if model.joinState == .joining {
                        ProgressView()
                        Text("Joining…")
                    } else {
                        Label("Join Network", systemImage: "wifi")
                    }
                    Spacer()
                }
            }
            .disabled(!model.credentials.canJoin || model.joinState == .joining)

            joinStatus
        }
    }

    @ViewBuilder
    private var joinStatus: some View {
        switch model.joinState {
        case .idle, .joining:
            EmptyView()
        case .joined(let ssid):
            Label("Connected to “\(ssid)”.", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .unconfirmed(let ssid):
            Label(
                "iOS saved “\(ssid)” but didn't connect. The network may be out of range or the password may be wrong. Check Settings › Wi-Fi.",
                systemImage: "exclamationmark.triangle.fill"
            )
            .foregroundStyle(.orange)
        case .failed(let message):
            Label(message, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
        }
    }

    private var photoSection: some View {
        Section("Photo") {
            Button {
                Task { await takePhoto() }
            } label: {
                Label("Take Photo", systemImage: "camera")
            }
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("Choose Photo", systemImage: "photo.on.rectangle")
            }
            if let image = model.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 220)
                    .accessibilityLabel("Selected photo")
            }
        }
    }

    private var linesSection: some View {
        Section {
            if model.isRecognizing {
                HStack {
                    ProgressView()
                    Text("Reading text…").foregroundStyle(.secondary)
                }
            } else if let error = model.recognitionError {
                Text(error).foregroundStyle(.secondary)
            } else if model.lines.isEmpty {
                Text("Take or choose a photo of the printed network name and password.")
                    .foregroundStyle(.secondary)
            } else {
                Picker("Tapping a line sets", selection: $model.nextField) {
                    Text("Network").tag(ScanViewModel.Field.ssid)
                    Text("Password").tag(ScanViewModel.Field.password)
                }
                .pickerStyle(.segmented)

                ForEach(model.lines) { line in
                    Button {
                        model.use(line)
                    } label: {
                        lineRow(line)
                    }
                }
            }
        } header: {
            Text("Recognized Text")
        } footer: {
            if !model.lines.isEmpty {
                Text("Tap the line with the network name, then the line with the password. Labels like “SSID:” and “Password:” are removed.")
            }
        }
    }

    private func lineRow(_ line: RecognizedLine) -> some View {
        HStack {
            Text(line.text)
                .font(.body.monospaced())
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
            Spacer()
            switch model.field(for: line) {
            case .ssid:
                Text("Network").font(.caption.bold()).foregroundStyle(.tint)
            case .password:
                Text("Password").font(.caption.bold()).foregroundStyle(.tint)
            case nil:
                EmptyView()
            }
        }
    }

    // MARK: - Actions

    @MainActor
    private func takePhoto() async {
        let status = await CameraAccess.request()
        if status == .granted {
            showingCamera = true
        } else {
            cameraAlert = status
        }
    }
}

private extension View {
    func credentialFieldStyle() -> some View {
        textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.body.monospaced())
    }
}

#Preview {
    CaptureView()
}
