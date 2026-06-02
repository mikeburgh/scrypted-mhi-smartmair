# Scrypted MHI Smart M-Air Plugin Implementation Plan

## Overview

This document outlines the implementation plan for a Scrypted plugin that controls Mitsubishi Heavy Industries (MHI) WF-RAC air conditioners using the Smart M-Air WiFi module. The plugin is based on the [homebridge-mhi-wfrac](https://github.com/JobDoesburg/homebridge-mhi-wfrac) project.

## Goals

1. Create a Scrypted plugin that exposes MHI AC units as smart home devices
2. Support multiple AC units per installation
3. Expose outdoor temperature as a separate sensor device
4. Provide thermostat control (modes, target temperature)
5. Provide fan speed control
6. Support dry/dehumidifier mode

---

## Architecture

### Plugin Structure

```
smartmair/
├── package.json              # NPM package with Scrypted metadata
├── tsconfig.json             # TypeScript configuration
├── .vscode/
│   └── settings.json         # VS Code debug settings
└── src/
    ├── main.ts               # Plugin entry point & DeviceProvider
    ├── api.ts                # MHI protocol implementation (ported from homebridge)
    ├── unit.ts               # AC unit device class
    └── outdoor-sensor.ts     # Outdoor temperature sensor device class
```

### Device Hierarchy

```
MHISmartMAirProvider (DeviceProvider)
├── Settings: operatorId, polling interval
├── Per-device settings: name, IP, MAC
│
├── Living Room AC (MHIACUnit - Thermostat type)
│   ├── Interfaces: TemperatureSetting, Thermometer, Fan, OnOff, Settings, Refresh
│   └── Living Room AC Outdoor Temp (MHIOutdoorSensor - Sensor type)
│       └── Interfaces: Thermometer
│
├── Bedroom AC (MHIACUnit)
│   └── Bedroom AC Outdoor Temp (MHIOutdoorSensor)
│
└── ... more units
```

---

## Scrypted Interfaces to Implement

### Main Provider Class (`MHISmartMAirProvider`)

| Interface | Purpose |
|-----------|---------|
| `DeviceProvider` | Manages multiple AC unit devices |
| `Settings` | Plugin-level configuration (operator ID, add/remove devices) |

### AC Unit Device (`MHIACUnit`)

| Interface | Purpose |
|-----------|---------|
| `TemperatureSetting` | Thermostat mode control (Off, Cool, Heat, Auto, Dry, FanOnly) |
| `Thermometer` | Indoor temperature reading |
| `Fan` | Fan speed control (Auto, Low, Medium, High, Highest) |
| `OnOff` | Power on/off |
| `Settings` | Per-device settings (IP address, name) |
| `Refresh` | Manual refresh trigger |

### Outdoor Temperature Sensor (`MHIOutdoorSensor`)

| Interface | Purpose |
|-----------|---------|
| `Thermometer` | Outdoor temperature reading |

---

## Mode Mappings

### MHI Operation Modes → Scrypted ThermostatMode

| MHI Mode | Scrypted ThermostatMode |
|----------|------------------------|
| `auto` | `ThermostatMode.Auto` |
| `cool` | `ThermostatMode.Cool` |
| `heat` | `ThermostatMode.Heat` |
| `fan` | `ThermostatMode.FanOnly` |
| `dry` | `ThermostatMode.Dry` |
| (off) | `ThermostatMode.Off` |

### MHI Fan Speeds → Scrypted Fan Speed

| MHI Airflow | Scrypted Speed (0-100) |
|-------------|------------------------|
| `auto` | Mode: Auto, Speed: 0 |
| `lowest` | Mode: Manual, Speed: 25 |
| `low` | Mode: Manual, Speed: 50 |
| `high` | Mode: Manual, Speed: 75 |
| `highest` | Mode: Manual, Speed: 100 |

---

## API Protocol Details (from homebridge-mhi-wfrac)

### Communication

- **Endpoint**: `http://<ip>:51443/beaver/command`
- **Method**: HTTP POST with JSON body
- **Port**: 51443

### Request Format

```json
{
  "apiVer": "1.0",
  "command": "getAirconStat" | "setAirconStat",
  "deviceId": "<mac-address>",
  "operatorId": "<uuid>",
  "timestamp": <unix-timestamp>
}
```

### Response Format

```json
{
  "contents": {
    "airconStat": "<base64-encoded-status>",
    "autoHeating": 0,
    "electric": <power-consumption>,
    "errorCode": "",
    "outdoorTemp": <temperature-index>,
    "indoorTemp": <temperature-index>
  }
}
```

### Status Encoding

The AC status is encoded as base64 data with:
- Byte positions for operation mode, target temp, fan speed, etc.
- CRC-16-CCITT checksum for data integrity
- Temperature lookup tables (256 entries each for indoor/outdoor)

---

## Implementation Steps

### Phase 1: Project Setup

1. **Create package.json**
   - Name: `@scrypted/mhi-smartmair`
   - Dependencies: `@scrypted/sdk`, `axios`
   - Scrypted metadata with DeviceProvider type

2. **Create tsconfig.json**
   - Standard Scrypted plugin TypeScript config

3. **Create VS Code settings**
   - Debug configuration for Scrypted development

### Phase 2: Port MHI Protocol

4. **Create `src/api.ts`**
   - Port `DeviceStatus` class with:
     - Temperature lookup tables (indoor/outdoor)
     - Operation mode enums
     - Airflow level enums
     - `fromBase64()` decoder
     - `toBase64()` encoder
     - `crc16ccitt()` checksum calculation
   - Port `DeviceClient` class with:
     - `getDeviceStatus()` - fetch current state
     - `setDeviceStatus()` - send commands
     - Convenience methods for individual settings

### Phase 3: Implement Devices

5. **Create `src/outdoor-sensor.ts`**
   - Simple `Thermometer` implementation
   - Receives temperature updates from parent AC unit
   - Read-only device

6. **Create `src/unit.ts`**
   - `MHIACUnit` class extending `ScryptedDeviceBase`
   - Implement `TemperatureSetting`:
     - `setTemperature(command)` - set mode and/or target temp
     - `temperatureSetting` property - current mode/setpoint
   - Implement `Thermometer`:
     - `temperature` property - indoor temp in Celsius
   - Implement `Fan`:
     - `setFan(state)` - set fan speed/mode
     - `fan` property - current fan status
   - Implement `OnOff`:
     - `turnOn()` / `turnOff()` - power control
     - `on` property - current power state
   - Implement `Refresh`:
     - `refresh()` - manual status refresh
   - Implement `Settings`:
     - IP address (editable)
     - Device name
   - Create child outdoor sensor device
   - Polling loop for status updates (configurable interval)

7. **Create `src/main.ts`**
   - `MHISmartMAirProvider` class
   - Implement `DeviceProvider`:
     - `getDevice(nativeId)` - return AC unit or sensor instance
     - `releaseDevice()` - cleanup
   - Implement `Settings`:
     - Operator ID (required)
     - Polling interval (default: 10 seconds)
     - Device list management (add/edit/remove)
   - Device discovery via `deviceManager.onDevicesChanged()`

### Phase 4: Testing & Refinement

8. **Test basic functionality**
   - Power on/off
   - Mode changes
   - Temperature setpoint
   - Fan speed changes
   - Indoor/outdoor temperature readings

9. **Error handling**
   - Connection timeouts
   - Device offline detection
   - Invalid responses

10. **Polish**
    - Logging improvements
    - State persistence
    - UI refinements

---

## Configuration UI

### Plugin Settings

| Setting | Type | Description |
|---------|------|-------------|
| Operator ID | string (password) | UUID from Smart M-Air app |
| Polling Interval | number | Seconds between status updates (default: 10) |
| Devices | button | Opens device management |

### Device Settings (per AC unit)

| Setting | Type | Description |
|---------|------|-------------|
| Name | string | Display name for the device |
| IP Address | string | IP address of the AC unit |
| MAC Address | string | MAC address / serial number (12 hex chars) |

### Add Device Flow

1. User clicks "Add Device" in plugin settings
2. User enters: Name, IP Address, MAC Address
3. Plugin validates connection to device
4. Device appears in Scrypted with indoor temp sensor
5. Outdoor temp sensor created as child device

---

## Data Flow

### Status Polling

```
┌─────────────────┐     HTTP POST      ┌─────────────────┐
│  MHIACUnit      │ ──────────────────>│  AC Unit        │
│  (polling)      │                    │  (port 51443)   │
│                 │ <──────────────────│                 │
└─────────────────┘    JSON response   └─────────────────┘
        │
        │ Update properties
        ▼
┌─────────────────┐
│ Scrypted State  │
│ - temperature   │
│ - mode          │
│ - fan speed     │
│ - on/off        │
└─────────────────┘
        │
        │ Notify child
        ▼
┌─────────────────┐
│ OutdoorSensor   │
│ - temperature   │
└─────────────────┘
```

### Command Flow

```
┌─────────────────┐                    ┌─────────────────┐
│ Scrypted UI     │ ─── setTemperature ─>│  MHIACUnit     │
│ or Automation   │                    │                 │
└─────────────────┘                    └────────┬────────┘
                                                │
                                    Build command payload
                                                │
                                                ▼
                                       ┌─────────────────┐
                                       │  DeviceClient   │
                                       │  HTTP POST      │
                                       └────────┬────────┘
                                                │
                                                ▼
                                       ┌─────────────────┐
                                       │  AC Unit        │
                                       │  (execute)      │
                                       └─────────────────┘
```

---

## Future Enhancements

1. **Auto-discovery**: Query network for MHI devices instead of manual entry
2. **Horizontal/Vertical vane control**: Expose as additional settings or device
3. **Away mode**: Expose the built-in away/vacation mode
4. **Energy monitoring**: Expose power consumption readings
5. **Error code reporting**: Surface AC error codes to Scrypted

---

## References

- [homebridge-mhi-wfrac](https://github.com/JobDoesburg/homebridge-mhi-wfrac) - Source Homebridge plugin
- [Scrypted Plugin Development](https://developer.scrypted.app/plugins.html)
- [Scrypted SDK Interfaces](https://developer.scrypted.app/gen/globals.html)
- [ThermostatMode](https://developer.scrypted.app/gen/enumerations/ThermostatMode.html)
- [TemperatureSetting](https://developer.scrypted.app/gen/interfaces/TemperatureSetting.html)
- [Fan Interface](https://developer.scrypted.app/gen/interfaces/Fan.html)
- [DeviceProvider](https://developer.scrypted.app/gen/interfaces/DeviceProvider.html)
