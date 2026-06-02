/**
 * MHI AC Unit Device
 *
 * Represents a single MHI WF-RAC air conditioner unit with full control
 * capabilities including thermostat, fan speed, and power control.
 */

import sdk, {
  ScryptedDeviceBase,
  TemperatureSetting,
  TemperatureSettingStatus,
  TemperatureCommand,
  Thermometer,
  TemperatureUnit,
  ThermostatMode,
  Fan,
  FanState,
  FanStatus,
  FanMode,
  OnOff,
  Refresh,
  Settings,
  Setting,
  ScryptedInterface,
  ScryptedDeviceType,
} from '@scrypted/sdk';

import {
  DeviceClient,
  DeviceStatus,
  OperationMode,
  AirflowLevel,
} from './api';

import { MHIOutdoorSensor } from './outdoor-sensor';

const { deviceManager } = sdk;

/**
 * Map MHI operation modes to Scrypted thermostat modes
 */
function mhiModeToScrypted(mode: OperationMode, isOn: boolean): ThermostatMode {
  if (!isOn) return ThermostatMode.Off;

  switch (mode) {
    case OperationMode.Auto:
      return ThermostatMode.Auto;
    case OperationMode.Cool:
      return ThermostatMode.Cool;
    case OperationMode.Heat:
      return ThermostatMode.Heat;
    case OperationMode.Fan:
      return ThermostatMode.FanOnly;
    case OperationMode.Dry:
      return ThermostatMode.Dry;
    default:
      return ThermostatMode.Auto;
  }
}

/**
 * Map Scrypted thermostat modes to MHI operation modes
 */
function scryptedModeToMhi(mode: ThermostatMode): { operation: boolean; mode: OperationMode } {
  switch (mode) {
    case ThermostatMode.Off:
      return { operation: false, mode: OperationMode.Auto };
    case ThermostatMode.Cool:
      return { operation: true, mode: OperationMode.Cool };
    case ThermostatMode.Heat:
      return { operation: true, mode: OperationMode.Heat };
    case ThermostatMode.Auto:
    case ThermostatMode.HeatCool:
      return { operation: true, mode: OperationMode.Auto };
    case ThermostatMode.FanOnly:
      return { operation: true, mode: OperationMode.Fan };
    case ThermostatMode.Dry:
      return { operation: true, mode: OperationMode.Dry };
    default:
      return { operation: true, mode: OperationMode.Auto };
  }
}

/**
 * Map MHI airflow levels to fan speed percentage (0-100)
 */
function airflowToSpeed(airflow: AirflowLevel): number {
  switch (airflow) {
    case AirflowLevel.Auto:
      return 0; // Auto mode represented as 0
    case AirflowLevel.Lowest:
      return 25;
    case AirflowLevel.Low:
      return 50;
    case AirflowLevel.High:
      return 75;
    case AirflowLevel.Highest:
      return 100;
    default:
      return 0;
  }
}

/**
 * Map fan speed percentage to MHI airflow level
 */
function speedToAirflow(speed: number): AirflowLevel {
  if (speed <= 0) return AirflowLevel.Auto;
  if (speed <= 25) return AirflowLevel.Lowest;
  if (speed <= 50) return AirflowLevel.Low;
  if (speed <= 75) return AirflowLevel.High;
  return AirflowLevel.Highest;
}

/**
 * Configuration for an AC unit
 */
export interface ACUnitConfig {
  name: string;
  ip: string;
  mac: string;
  operatorId: string;
  pollingInterval: number;
}

/**
 * MHI AC Unit Device Class
 */
export class MHIACUnit extends ScryptedDeviceBase
  implements TemperatureSetting, Thermometer, Fan, OnOff, Refresh, Settings {

  private client: DeviceClient;
  private config: ACUnitConfig;
  private pollTimer?: NodeJS.Timeout;
  private outdoorSensor?: MHIOutdoorSensor;
  private lastStatus?: DeviceStatus;

  // Provider reference for device updates
  private provider: {
    getOutdoorSensor(nativeId: string): MHIOutdoorSensor | undefined;
  };

  constructor(
    nativeId: string,
    config: ACUnitConfig,
    provider: {
      getOutdoorSensor(nativeId: string): MHIOutdoorSensor | undefined;
    }
  ) {
    super(nativeId);
    this.config = config;
    this.provider = provider;

    // Initialize API client
    this.client = new DeviceClient(config.ip, config.mac, config.operatorId);

    // Set initial state
    this.temperatureUnit = TemperatureUnit.C;
    this.on = false;

    // Initialize temperature setting with available modes
    this.temperatureSetting = {
      availableModes: [
        ThermostatMode.Off,
        ThermostatMode.Cool,
        ThermostatMode.Heat,
        ThermostatMode.Auto,
        ThermostatMode.FanOnly,
        ThermostatMode.Dry,
      ],
      mode: ThermostatMode.Off,
      setpoint: 24,
    };

    // Initialize fan status
    this.fan = {
      speed: 0,
      mode: FanMode.Auto,
      maxSpeed: 100,
      availableModes: [FanMode.Auto, FanMode.Manual],
    };

    // Start polling
    this.startPolling();

    this.console.log(`MHI AC Unit initialized: ${config.name} (${config.ip})`);
  }

  /**
   * Start the polling loop for status updates
   */
  private startPolling(): void {
    // Initial poll
    this.refresh();

    // Set up interval
    this.pollTimer = setInterval(() => {
      this.pollStatus();
    }, this.config.pollingInterval * 1000);
  }

  /**
   * Stop the polling loop
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Poll current status from the device
   */
  private async pollStatus(): Promise<void> {
    try {
      const status = await this.client.getDeviceStatus();
      if (status) {
        this.updateFromStatus(status);
      }
    } catch (error) {
      this.console.error('Error polling status:', error);
    }
  }

  /**
   * Update device state from API response
   */
  private updateFromStatus(status: DeviceStatus): void {
    this.lastStatus = status;

    // Update power state
    this.on = status.operation;

    // Update indoor temperature
    this.temperature = status.indoorTemp;

    // Update thermostat mode and setpoint
    const mode = mhiModeToScrypted(status.operationMode, status.operation);
    this.temperatureSetting = {
      availableModes: [
        ThermostatMode.Off,
        ThermostatMode.Cool,
        ThermostatMode.Heat,
        ThermostatMode.Auto,
        ThermostatMode.FanOnly,
        ThermostatMode.Dry,
      ],
      mode,
      activeMode: mode,
      setpoint: status.presetTemp,
    };

    // Update fan status
    const isAuto = status.airflow === AirflowLevel.Auto;
    this.fan = {
      speed: airflowToSpeed(status.airflow),
      mode: isAuto ? FanMode.Auto : FanMode.Manual,
      maxSpeed: 100,
      availableModes: [FanMode.Auto, FanMode.Manual],
      active: status.operation,
    };

    // Update outdoor sensor
    const outdoorSensorNativeId = `${this.nativeId}-outdoor`;
    const outdoorSensor = this.provider.getOutdoorSensor(outdoorSensorNativeId);
    if (outdoorSensor && status.outdoorTemp !== undefined) {
      outdoorSensor.updateTemperature(status.outdoorTemp);
    }
  }

  // ============================================
  // TemperatureSetting Interface
  // ============================================

  async setTemperature(command: TemperatureCommand): Promise<void> {
    this.console.log('setTemperature called:', JSON.stringify(command));

    try {
      const status = await this.client.getDeviceStatus();
      if (!status) {
        this.console.error('Failed to get current status');
        return;
      }

      this.console.log(`Current state: operation=${status.operation}, mode=${status.operationMode}, temp=${status.presetTemp}`);

      // Handle mode change
      if (command.mode !== undefined) {
        const { operation, mode } = scryptedModeToMhi(command.mode);
        this.console.log(`Mode change: ${command.mode} -> operation=${operation}, mhiMode=${mode}`);
        status.operation = operation;
        if (operation) {
          status.operationMode = mode;
        }
      }

      // Handle setpoint change
      if (command.setpoint !== undefined) {
        const setpoint = Array.isArray(command.setpoint)
          ? command.setpoint[0]
          : command.setpoint;

        // Clamp to valid range and round to 0.5 increments
        status.presetTemp = Math.max(18, Math.min(30, Math.round(setpoint * 2) / 2));
        this.console.log(`Setpoint change: ${command.setpoint} -> ${status.presetTemp}`);
      }

      this.console.log(`Sending: operation=${status.operation}, mode=${status.operationMode}, temp=${status.presetTemp}`);

      // Send command
      const success = await this.client.setDeviceStatus(status);
      if (success) {
        this.console.log('Command sent successfully');
        this.updateFromStatus(status);
      } else {
        this.console.error('Failed to set temperature - setDeviceStatus returned false');
      }
    } catch (error) {
      this.console.error('Error setting temperature:', error);
    }
  }

  async setTemperatureUnit(unit: TemperatureUnit): Promise<void> {
    this.temperatureUnit = unit;
  }

  // ============================================
  // Fan Interface
  // ============================================

  async setFan(fan: FanState): Promise<void> {
    this.console.log('setFan called:', JSON.stringify(fan));

    try {
      let airflow: AirflowLevel;

      if (fan.mode === FanMode.Auto) {
        airflow = AirflowLevel.Auto;
      } else if (fan.speed !== undefined) {
        airflow = speedToAirflow(fan.speed);
      } else {
        return;
      }

      const success = await this.client.setAirflow(airflow);
      if (success) {
        // Refresh to get updated status
        await this.pollStatus();
      } else {
        this.console.error('Failed to set fan');
      }
    } catch (error) {
      this.console.error('Error setting fan:', error);
    }
  }

  // ============================================
  // OnOff Interface
  // ============================================

  async turnOn(): Promise<void> {
    this.console.log('turnOn called');

    try {
      const success = await this.client.setOperation(true);
      if (success) {
        this.on = true;
        await this.pollStatus();
      } else {
        this.console.error('Failed to turn on');
      }
    } catch (error) {
      this.console.error('Error turning on:', error);
    }
  }

  async turnOff(): Promise<void> {
    this.console.log('turnOff called');

    try {
      const success = await this.client.setOperation(false);
      if (success) {
        this.on = false;
        await this.pollStatus();
      } else {
        this.console.error('Failed to turn off');
      }
    } catch (error) {
      this.console.error('Error turning off:', error);
    }
  }

  // ============================================
  // Refresh Interface
  // ============================================

  async getRefreshFrequency(): Promise<number> {
    // Return polling interval in seconds
    return this.config.pollingInterval;
  }

  async refresh(refreshInterface?: string, userInitiated?: boolean): Promise<void> {
    this.console.log('refresh called');
    await this.pollStatus();
  }

  // ============================================
  // Settings Interface
  // ============================================

  async getSettings(): Promise<Setting[]> {
    return [
      {
        key: 'name',
        title: 'Name',
        description: 'Display name for this AC unit',
        type: 'string',
        value: this.config.name,
      },
      {
        key: 'ip',
        title: 'IP Address',
        description: 'IP address of the AC unit',
        type: 'string',
        value: this.config.ip,
      },
      {
        key: 'mac',
        title: 'MAC Address',
        description: 'MAC address / serial number (12 hex characters, no separators)',
        type: 'string',
        value: this.config.mac,
        readonly: true,
      },
    ];
  }

  async putSetting(key: string, value: string): Promise<void> {
    if (key === 'ip') {
      this.config.ip = value;
      // Recreate client with new IP
      this.client = new DeviceClient(this.config.ip, this.config.mac, this.config.operatorId);
      this.console.log(`IP address updated to ${value}`);
    } else if (key === 'name') {
      this.config.name = value;
      // Update device name in Scrypted
      await deviceManager.onDeviceDiscovered({
        nativeId: this.nativeId!,
        name: value,
        type: ScryptedDeviceType.Thermostat,
        interfaces: [
          ScryptedInterface.TemperatureSetting,
          ScryptedInterface.Thermometer,
          ScryptedInterface.Fan,
          ScryptedInterface.OnOff,
          ScryptedInterface.Refresh,
          ScryptedInterface.Settings,
        ],
      });
    }
  }

  /**
   * Update configuration (called when provider settings change)
   */
  updateConfig(config: Partial<ACUnitConfig>): void {
    if (config.operatorId && config.operatorId !== this.config.operatorId) {
      this.config.operatorId = config.operatorId;
      this.client = new DeviceClient(this.config.ip, this.config.mac, this.config.operatorId);
    }

    if (config.pollingInterval && config.pollingInterval !== this.config.pollingInterval) {
      this.config.pollingInterval = config.pollingInterval;
      this.stopPolling();
      this.startPolling();
    }

    if (config.ip && config.ip !== this.config.ip) {
      this.config.ip = config.ip;
      this.client = new DeviceClient(this.config.ip, this.config.mac, this.config.operatorId);
    }
  }
}
