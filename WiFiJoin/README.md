# WiFiJoin

Photograph a printed Wi-Fi network name and password, confirm the text, and join the network.

- **Capture:** take a photo with the camera, or choose one with the photo picker.
- **Read:** Vision's `VNRecognizeTextRequest` (`.accurate`, language correction off) lists every line of text it finds.
- **Confirm:** tap the line with the network name, then the line with the password. Labels such as `SSID:` and `Password:` are removed. You can edit both fields. The app never guesses the fields for you.
- **Join:** `NEHotspotConfigurationManager.shared.apply(_:)` with `NEHotspotConfiguration(ssid:passphrase:isWEP: false)` and `joinOnce = false`.

Requires iOS 16 or later. Uses only system frameworks: SwiftUI, PhotosUI, Vision and NetworkExtension.

## Project layout

```
WiFiJoin.xcodeproj
WiFiJoin/
  WiFiJoinApp.swift              App entry point
  Models/WiFiCredentials.swift   Credentials, validation, label stripping
  ViewModels/ScanViewModel.swift Text recognition and joining
  Views/CaptureView.swift        The main screen
  Views/CameraPicker.swift       Camera wrapper and camera permission
  Info.plist                     NSCameraUsageDescription
  WiFiJoin.entitlements          Hotspot Configuration and Access Wi-Fi Information
```

## Setup in Xcode

1. Open `WiFiJoin.xcodeproj`.
2. Select the **WiFiJoin** target, then **Signing & Capabilities**.
3. Choose your **Team**, and change the **Bundle Identifier** from `com.example.WiFiJoin` to one you own.
4. Check that **Hotspot Configuration** and **Access Wi-Fi Information** are listed. The entitlements file already requests both. If Xcode shows a signing error, remove each capability and add it again with **+ Capability**.

## Testing notes

- **Use a physical device.** `NEHotspotConfiguration` does not work in the Simulator, and the Simulator has no camera. In the Simulator you can test photo picking and text recognition, but not joining.
- **The app cannot join silently.** iOS always shows its own "Wants to Join Wi-Fi Network" prompt. The user must tap **Join**. If they tap **Cancel**, the app shows "You declined to join the network."
- **A paid Apple Developer account is required for device builds.** The Hotspot Configuration capability is not available to free (Personal Team) accounts, so signing fails without a paid membership.
- **A successful `apply` does not prove the device connected.** iOS often reports success even when the network is out of range or the password is wrong. After `apply` succeeds, the app uses `NEHotspotNetwork.fetchCurrent()` to check which network the device is on. This needs the Access Wi-Fi Information capability. If the device is not on the network after a few seconds, the app shows a warning instead of a success message.
- **The configuration is saved** because `joinOnce` is `false`. To test the prompt again, go to **Settings › Wi-Fi**, tap the network, and tap **Forget This Network**.
- **Passwords must be 8 to 63 ASCII characters**, or 64 hex digits. The app checks this before it joins, because a single misread character is the most common problem.
