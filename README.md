# Re:imagine Smart Home Hub

A local-first smart-home stack for controlling mixed-brand Wi-Fi appliances without a cloud dependency:

- `hub/` is the Node.js gateway. It owns device drivers, SSDP/mDNS discovery, Wake-on-LAN, REST endpoints, token authentication, and the WebSocket event stream.
- `app/` is the Expo Router mobile client. It groups devices by room, shows live state, and presents device-specific TV, light, AC, and plug controls.
- `desktop/` is an optional Electron client for the same hub.

## Quick start

1. Start the hub on a computer connected to the same LAN as your devices.
2. Copy the hub URL and token from `hub/config.json` (the URL uses the hub computer’s LAN IP, not `localhost`, when connecting from a phone).
3. Start the app and enter that URL and token in **Settings**. Use **Test connection** to verify the authenticated API connection.
4. Use **Discover devices (mDNS / SSDP)** on the Home screen. Supported Shelly devices and Samsung/LG TVs can be added from the results; the hub saves them for you. Approve the pairing prompt on a TV when it appears.

## Hub setup and verification

```bash
cd hub
npm install
npm run dev
```

The hub listens on `0.0.0.0:8321` by default. Keep it running while using the mobile or desktop client. The main endpoints are:

- `GET /api/status` — authenticated connection check
- `GET /api/devices` and `GET /api/devices/:id` — device snapshots
- `POST /api/devices/:id/action` — execute a driver action
- `POST /api/discover` — run SSDP/mDNS discovery from the hub host
- `POST /api/devices/discovered` — register a supported result from the latest discovery scan
- `ws://<hub-ip>:8321/ws` — authenticated live status and device events (token is sent as a WebSocket subprotocol, never in the URL)

Discovery and registration happen on the hub computer. The app offers automatic setup for detected Shelly devices and Samsung/LG TVs; Hue bridges and other devices may need an integration-specific pairing step or credentials before they can be controlled. Discovery does not guarantee every device is visible: the hub and device must be on the same LAN/VLAN, and the router must permit multicast discovery.

By default, only the opaque `null` origin used by the bundled Electron file-based client is allowed. If you use a browser-hosted client, add its exact origin to `corsOrigins` in `hub/config.json`, for example `"corsOrigins": ["null", "http://localhost:8081"]`. The same allowlist applies to WebSocket handshakes; native app connections without an `Origin` header are unaffected. The `null` origin does not grant unauthenticated API access; all device and WebSocket operations still require the hub token. Keep the hub token private and use a trusted LAN or HTTPS when connecting from a browser.

Build and type-check the hub:

```bash
cd hub
npm run verify
```

For the REST/WebSocket integration suite, leave `npm run dev` running in one terminal and run this in another:

```bash
cd hub
npm run test:integration
```

The verifier exercises token rejection, isolated mock-device actions, Sony remote-key and app-link dispatch, and live WebSocket updates. Network discovery uses the host’s LAN interfaces; allow the hub process through the computer firewall if discovery or device access is blocked.

## Expo mobile app setup

Install dependencies and start Expo from the app directory:

```bash
cd app
npm install
npm start
```

Type-check and run Expo’s project diagnostics:

```bash
npm run verify
```

### iOS simulator

Install Xcode and an iOS Simulator runtime. With the hub running on the same Mac, `http://127.0.0.1:8321` is reachable from the simulator; if the hub runs on another computer, use that computer’s LAN IP.

- Press `i` in the Expo terminal, or run `npm run ios`, to open the project in an available simulator using the Expo development workflow.
- For a locally compiled native development build, run `npx expo run:ios` with Xcode installed. Expo generates the native project as part of Continuous Native Generation.

### Android emulator

Install Android Studio, an Android SDK, and start an emulator.

- Press `a` in the Expo terminal, or run `npm run android`, to open the project in the emulator using the Expo development workflow.
- For an emulator connecting to a hub on the same computer, use `http://10.0.2.2:8321`. If the hub is on another LAN computer, use its LAN IP.
- For a locally compiled native development build, run `npx expo run:android` with Android SDK tools installed.

### Physical iOS or Android device

1. Connect the phone and hub computer to the same Wi-Fi/LAN.
2. Start Expo with `npm start` and scan its QR code using Expo Go, or install a development build.
3. In the app’s **Settings**, enter the hub computer’s LAN address (for example, `http://192.168.1.50:8321`) and the token from `hub/config.json`; tap **Test connection**, then save.
4. Keep the phone and hub on the same reachable network. Guest Wi-Fi/client isolation, VPNs, and host firewalls can prevent local connections. `localhost` on the phone refers to the phone itself, not the hub computer.

The Expo config declares iOS local-network usage and enables Android cleartext traffic so a local `http://` hub URL works in native builds. Android's cleartext setting applies to the app generally, not only the LAN hub; use the app only on trusted networks because a token sent over HTTP is not encrypted in transit. Prefer HTTPS if you expose the hub beyond a trusted LAN. Rebuild the native app after changing native configuration; Expo Go’s native permissions are managed by Expo Go itself.

## Desktop app setup

The desktop client uses Electron, keeping the existing HTML/JavaScript UI while placing hub access, WebSocket authentication, settings storage, tray handling, and operating-system integration in the main process. Renderer IPC is limited to operations for settings, listing devices, actions, and discovery; it does not expose general filesystem, shell, or socket access. The hub token is encrypted with the OS credential store and is never sent to the UI window. Local HTTP is not encrypted in transit, so use the desktop client only on a trusted LAN unless the hub is configured for HTTPS. SSDP/mDNS sockets remain in the hub so all clients use the same discovery lifecycle and network permissions.

```bash
cd desktop
npm install
npm start
```

Configure the hub URL and token in **Settings**. Closing the main window hides HomeHub to the system tray; use the tray menu to reopen it or quit. The menu and Settings also control launch-at-login on macOS and Windows. Tray discovery asks the configured hub to run its SSDP/mDNS scan, so discovery happens on the hub computer's network.

Mock/demo devices are hidden in the app. Select a real device card to expand its available controls; TV cards include icon-based remote buttons and an **Applications** row with one-tap launch buttons for installed Netflix, Prime Video, Hotstar, and YouTube apps. Sony uses the TV's Leanback launcher intent for each app package rather than opening service websites. Streaming apps must be installed on the TV. The Sony input controls include the input menu and direct HDMI 1–4 key commands; direct HDMI switching depends on the TV exposing those inputs. A newly generated hub configuration starts with no devices, which you can add through **Discover devices**.

On macOS, create a directly launchable app bundle and install it in your user Applications folder:

```bash
cd desktop
npm run pack
mkdir -p "$HOME/Applications"
ditto dist/mac-arm64/HomeHub.app "$HOME/Applications/HomeHub.app"
ln -s "$HOME/Applications/HomeHub.app" "$HOME/Desktop/HomeHub.app"
```

Open **HomeHub.app** from the Desktop shortcut or Applications folder. If the Desktop shortcut already exists, remove that specific shortcut before re-running `ln -s`.

Check and package the application:

```bash
npm run check
npm run pack       # unpacked app directory for local smoke tests
npm run dist:mac   # macOS DMG and ZIP
npm run dist:win   # Windows NSIS installer
```

Run `dist:mac` on macOS and `dist:win` on Windows for native packaging. The CI workflow builds both targets on their matching hosted operating systems and uploads unsigned test artifacts. Production distribution still requires platform signing (and macOS notarization); configure signing credentials in protected CI secrets before publishing installers. Build artifacts are written to `desktop/dist/`.

The runtime dependency audit is clean. The current Electron Builder toolchain still has moderate-severity advisories in transitive build-only packages; do not use it with untrusted build inputs, and rerun `npm audit` before release. The resolved builder version is kept at a release that fixes the reported high/critical packaging advisories rather than downgrading to an older release with more severe findings.

## Device pairing guide

### Samsung TV

1. Enable Remote Access / Mobile Device access on the TV.
2. Run **Discover devices** in the app and tap **Add** for the detected TV.
3. Approve the TV's pairing prompt. The hub remembers the device after adding it.
4. For Wake-on-LAN power-on, the device's MAC address must be configured; discovery does not always provide it.

### LG webOS TV

1. Open the TV settings and enable Developer Mode / LG Connect Apps.
2. Run **Discover devices** in the app and tap **Add** for the detected TV.
3. Approve the TV's pairing prompt. The hub saves the pairing key for later connections.
4. For Wake-on-LAN power-on, the device's MAC address must be configured; discovery does not always provide it.

### Sony BRAVIA / Android TV

1. Keep the TV and hub on the same local network.
2. Run **Discover devices** and choose **Pair** beside the Sony TV. HomeHub starts Android TV Remote pairing; enter the six-character hexadecimal code shown on the TV (0–9 and A–F; spaces or dashes are ignored).
3. HomeHub saves the paired certificate locally and reconnects automatically on future starts. The certificate is private key material; the hub writes its config with owner-only permissions.
4. This pairing flow uses Android TV Remote v2. If the TV does not display a pairing code or rejects the connection, its firmware may not expose that protocol; the app reports the connection error without requiring a model number up front.

### Philips Hue bridge

The app can discover Hue bridges, but automatic pairing is not implemented yet. Hue requires pressing the physical bridge button and creating an API key before lights can be controlled.

### Shelly devices

1. Connect the Shelly device to the same LAN as the hub.
2. Run **Discover devices** in the app and tap **Add** for the detected device. The hub chooses the local Shelly API automatically.

### Tuya local devices

Automatic pairing is not implemented yet; Tuya local control requires device-specific credentials.

1. Obtain the device’s Tuya local key (for example via the Tuya developer flow or the Tuya local pairing workflow).
2. Add `driver: "tuya"` and configure:
   - `host` — local IP
   - `options.deviceId`
   - `options.localKey`
   - `options.version` (usually `3.3`)
3. If the device exposes a custom DP map, add `options.dps` to map the local API fields.

### MQTT appliances

1. Run an MQTT broker on the LAN.
2. Add `driver: "mqtt"` and set `options.url` to the broker endpoint.
3. Provide the topic mapping for power/status commands in `options`.

### Broadlink IR bridge

1. Put a Broadlink RM4/RM mini on the LAN and connect it to the same local network.
2. Use `driver: "broadlink-ir"` and set `host` to the bridge IP.
3. Configure `options.mac` or the `IR` mapping for your appliance brand and model.
4. This path is designed as a bridge for dumb IR AC units, not for direct Wi‑Fi controls.

## Verification checklist

Before shipping, run the following checks on a machine with Node installed:

```bash
cd Re_imagine/hub && npm run verify
cd Re_imagine/app && npm run typecheck
```

The hub and Android TV pairing package require Node.js 22 or newer.

In the integrated environment, re-run the hub verification script after any API contract change and confirm the app still points to the same token and device IDs.

## Notes

- The hub intentionally runs on the local network only.
- No IR blaster is required for native Wi‑Fi appliances.
- Keep `config.json` as the source of truth for pairing secrets and local hostnames.
