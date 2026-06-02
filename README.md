# MHI Smart M-Air Plugin for Scrypted

A Scrypted plugin for controlling Mitsubishi Heavy Industries (MHI) air conditioners equipped with the WF-RAC WiFi module (Smart M-Air).

## Features

- **Multiple AC Unit Support** - Control multiple MHI air conditioners from a single plugin
- **Auto-Discovery** - Scan your network to find MHI devices automatically
- **Auto-Registration** - Automatically registers "Scrypted" as an operator with the AC unit
- **Thermostat Control** - Off, Cool, Heat, Auto, Fan Only, Dry modes
- **Temperature Control** - Set target temperature (18-30°C in 0.5° increments)
- **Fan Speed Control** - Auto, Lowest, Low, High, Highest
- **Indoor Temperature** - Real-time indoor temperature readings
- **Outdoor Temperature** - Separate sensor for outdoor condenser temperature

## Supported Devices

This plugin works with MHI air conditioners that have the WF-RAC WiFi module, typically configured via the **Smart M-Air** mobile app.

Both firmware generations are supported, detected automatically per device:

- **Legacy firmware** - plain HTTP on port 51443 (`/beaver/command`)
- **WF-RAC-HTTPS firmware** (wireless v025 / MCU v200 and newer) - TLS on port 51443 (`/beaver/command/<command>`), using the unit's self-signed certificate

## Installation

1. In Scrypted, go to **Plugins** > **Install Plugin**
2. Search for "MHI Smart M-Air" or install from NPM: `@scrypted/mhi-smartmair`

## Setup

1. Open the plugin settings
2. In **Scan Network**, enter `AUTO` to automatically detect your network subnets
   - Or enter a specific subnet manually (e.g., `192.168.1` or `10.2.2`)
3. The plugin will automatically:
   - Scan for MHI devices on port 51443
   - Register "Scrypted" as an operator with each device
   - Add discovered devices to Scrypted
   - Update IP addresses if devices have moved

Your AC units will appear as thermostats, each with a separate outdoor temperature sensor.

## Device Interfaces

Each AC unit exposes:

| Interface | Description |
|-----------|-------------|
| TemperatureSetting | Thermostat mode and target temperature |
| Thermometer | Current indoor temperature |
| Fan | Fan speed control |
| OnOff | Power on/off |
| Refresh | Manual status refresh |

Each AC unit also creates a child **Outdoor Temperature Sensor**.

## Settings

### Plugin Settings

| Setting | Description |
|---------|-------------|
| Polling Interval | How often to poll device status (5-60 seconds, default: 10) |

### Discovery Settings

| Setting | Description |
|---------|-------------|
| Scan Network | Enter `AUTO` to auto-detect subnets, or enter manually (e.g., "192.168.1") |
| Last Discovery Result | Shows results of the last scan |
| Add Device by IP | Add a specific device by IP address |

### Device Settings

| Setting | Description |
|---------|-------------|
| Name | Display name for the AC unit |
| IP Address | Network address of the AC unit |
| MAC Address | Device identifier (read-only) |

## Thermostat Modes

| Mode | Description |
|------|-------------|
| Off | Power off |
| Cool | Cooling mode |
| Heat | Heating mode |
| Auto | Automatic mode |
| Fan Only | Fan only (no heating/cooling) |
| Dry | Dehumidifier mode |

> Apple HomeKit only supports Off / Heat / Cool / Auto, so **Fan Only** and **Dry** are not selectable from the Home app (they show as Auto there). They are available from the Scrypted UI and other integrations.

## Fan Speeds

| Level | Description |
|-------|-------------|
| Auto | Automatic fan speed |
| Lowest | 25% |
| Low | 50% |
| High | 75% |
| Highest | 100% |

## Troubleshooting

### Device Not Found

- Ensure the AC unit is connected to your network
- Check that port 51443 is accessible
- Try probing the specific IP address

### Commands Not Working

- The plugin auto-registers its operator ID - check the device console for errors
- Ensure your system clock is accurate (timestamps are required)

## Notes

- **Transport**: Each unit's transport is auto-detected - HTTPS first (newer WF-RAC-HTTPS firmware, self-signed certificate), falling back to plain HTTP (legacy firmware). No configuration needed. The same status-buffer encoding is used for both.
- **Temperature decoding**: Indoor and outdoor temperatures use the manufacturer lookup tables. The local-API indoor reading can sit a few tenths of a degree off the Smart M-Air app.
- **IP changes**: Re-running a scan will automatically update device IP addresses if they have changed (e.g., after DHCP renewal).

## Credits

Based on protocol work from:

- [homebridge-mhi-wfrac](https://github.com/JobDoesburg/homebridge-mhi-wfrac) by Job Doesburg
- [Mitsubishi-WF-RAC-Integration](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration) for Home Assistant
- [ioBroker.mhi-wfrac](https://github.com/hacki11/ioBroker.mhi-wfrac) by hacki11

## License

Apache-2.0
