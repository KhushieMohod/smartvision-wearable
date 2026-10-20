# SmartVision Wearable

AI and IoT-based navigation and safety assistance prototype. The existing web application supports a simulation-first dashboard and an optional Web Bluetooth connection to an ESP32 wearable.

## Live Demo

[Open SmartVision Wearable](https://smartvision-wearable.vercel.app/)

## Run the Application

```powershell
cd smartvision-app
npm install
npm run dev
```

Run `npm run build` for the production build. Web Bluetooth requires a supported Chromium-based browser and a secure context; `localhost` is supported for local development.

## ESP32 BLE Contract

The browser connects to an advertised device named `SmartVision-ESP32`. Implement one GATT service with these characteristics:

| Characteristic | UUID | Required behavior |
| --- | --- | --- |
| SmartVision service | `19b10000-e8f2-537e-4f6c-d104768a1214` | Primary service |
| Telemetry | `19b10001-e8f2-537e-4f6c-d104768a1214` | Notify or indicate complete telemetry objects |
| Command | `19b10002-e8f2-537e-4f6c-d104768a1214` | Accept JSON writes |
| Status | `19b10003-e8f2-537e-4f6c-d104768a1214` | Expose wearable status |

Telemetry notifications are UTF-8 JSON. Distances are centimeters, battery is a percentage or `null`, and `fall` / `sos` are booleans. Include `left`, `front`, and `right` with every packet; values must be finite and from 1 through 1000 cm. IMU may be omitted, but if present must include finite `ax`, `ay`, and `az` values. Send one complete JSON object per notification; the web client does not reassemble fragmented notifications. Keep the encoded object within the negotiated BLE notification payload size.

The browser writes `{"command":"start"}`, `{"command":"stop"}`, `{"command":"reset_emergency"}`, or `{"command":"vibrate","side":"left"}` / `{"command":"vibrate","side":"right"}` to the command characteristic.

## VL53L0X Bring-Up

Three VL53L0X sensors share the same default I²C address. ESP32 firmware must use configurable XSHUT GPIO definitions and bring sensors up individually before assigning distinct addresses (for example `0x30`, `0x31`, and `0x32`). GPIO assignments depend on the physical wiring and are intentionally not assumed by this repository. The web app consumes the resulting left/front/right telemetry and does not configure I²C hardware.

## Prototype Boundaries

Simulation is the default and remains available when Bluetooth is unsupported or the wearable is disconnected. Live mode displays only validated telemetry; camera AI, GPS, cloud sync, and caregiver networking are not connected by this web client. Fall detection is prototype-level and is not a certified safety system. SmartVision should complement, not replace, traditional mobility aids.