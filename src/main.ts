/**
 * MHI Smart M-Air Scrypted Plugin
 *
 * Main entry point and device provider for MHI WF-RAC air conditioners.
 * Supports multiple AC units per installation.
 */

import sdk, {
  ScryptedDeviceBase,
  DeviceProvider,
  Settings,
  Setting,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedNativeId,
} from '@scrypted/sdk';

import { MHIACUnit, ACUnitConfig } from './unit';
import { MHIOutdoorSensor } from './outdoor-sensor';
import {
  discoverDevices,
  probeDevice,
  registerOperator,
  generateUUID,
  DiscoveredDevice,
} from './api';

const { deviceManager } = sdk;

/**
 * Device configuration stored in plugin storage
 */
interface StoredDeviceConfig {
  name: string;
  ip: string;
  mac: string;
}

/**
 * Plugin storage schema
 */
interface PluginStorage {
  operatorId?: string;
  pollingInterval?: number;
  devices?: StoredDeviceConfig[];
}

/**
 * Default polling interval in seconds
 */
const DEFAULT_POLLING_INTERVAL = 10;

/**
 * Main Plugin Provider Class
 */
class MHISmartMAirProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
  private devices = new Map<string, MHIACUnit>();
  private outdoorSensors = new Map<string, MHIOutdoorSensor>();

  constructor(nativeId?: string) {
    super(nativeId);
    this.console.log('MHI Smart M-Air plugin starting...');

    // Discover devices on startup
    this.discoverDevices();
  }

  /**
   * Get plugin storage with defaults
   */
  private getStorage(): PluginStorage {
    return {
      operatorId: this.storage.getItem('operatorId') || undefined,
      pollingInterval: parseInt(this.storage.getItem('pollingInterval') || String(DEFAULT_POLLING_INTERVAL)),
      devices: JSON.parse(this.storage.getItem('devices') || '[]'),
    };
  }

  /**
   * Save a storage value
   */
  private setStorageItem(key: string, value: string): void {
    this.storage.setItem(key, value);
  }

  /**
   * Discover and register all configured devices
   */
  private async discoverDevices(): Promise<void> {
    const storage = this.getStorage();
    const devices = storage.devices || [];

    if (!storage.operatorId) {
      this.console.log('No operator ID configured. Please configure the plugin settings.');
      return;
    }

    if (devices.length === 0) {
      this.console.log('No devices configured. Add devices in plugin settings.');
      return;
    }

    this.console.log(`Discovering ${devices.length} device(s)...`);

    const discoveredDevices: {
      nativeId: string;
      name: string;
      type: ScryptedDeviceType;
      interfaces: string[];
    }[] = [];

    for (const device of devices) {
      // Main AC unit
      const unitNativeId = `mhi-${device.mac}`;
      discoveredDevices.push({
        nativeId: unitNativeId,
        name: device.name,
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

      // Outdoor temperature sensor (child device)
      const sensorNativeId = `${unitNativeId}-outdoor`;
      discoveredDevices.push({
        nativeId: sensorNativeId,
        name: `${device.name} Outdoor`,
        type: ScryptedDeviceType.Sensor,
        interfaces: [
          ScryptedInterface.Thermometer,
        ],
      });
    }

    // Register all devices with Scrypted
    await deviceManager.onDevicesChanged({
      providerNativeId: this.nativeId,
      devices: discoveredDevices,
    });

    this.console.log(`Discovered ${discoveredDevices.length} device(s)`);
  }

  // ============================================
  // DeviceProvider Interface
  // ============================================

  async getDevice(nativeId: string): Promise<MHIACUnit | MHIOutdoorSensor | undefined> {
    // Check if it's an outdoor sensor
    if (nativeId.endsWith('-outdoor')) {
      return this.getOutdoorSensorDevice(nativeId);
    }

    // It's an AC unit
    return this.getACUnitDevice(nativeId);
  }

  /**
   * Get or create an AC unit device
   */
  private getACUnitDevice(nativeId: string): MHIACUnit | undefined {
    // Return existing device if already created
    if (this.devices.has(nativeId)) {
      return this.devices.get(nativeId);
    }

    const storage = this.getStorage();
    if (!storage.operatorId) {
      this.console.error('No operator ID configured');
      return undefined;
    }

    // Find device config by MAC (nativeId is "mhi-{mac}")
    const mac = nativeId.replace('mhi-', '');
    const deviceConfig = storage.devices?.find(d => d.mac === mac);

    if (!deviceConfig) {
      this.console.error(`Device config not found for ${nativeId}`);
      return undefined;
    }

    // Create the AC unit
    const config: ACUnitConfig = {
      name: deviceConfig.name,
      ip: deviceConfig.ip,
      mac: deviceConfig.mac,
      operatorId: storage.operatorId,
      pollingInterval: storage.pollingInterval || DEFAULT_POLLING_INTERVAL,
    };

    const unit = new MHIACUnit(nativeId, config, {
      getOutdoorSensor: (id: string) => this.outdoorSensors.get(id),
    });

    this.devices.set(nativeId, unit);
    return unit;
  }

  /**
   * Get or create an outdoor sensor device
   */
  private getOutdoorSensorDevice(nativeId: string): MHIOutdoorSensor | undefined {
    // Return existing sensor if already created
    if (this.outdoorSensors.has(nativeId)) {
      return this.outdoorSensors.get(nativeId);
    }

    // Create the sensor
    const sensor = new MHIOutdoorSensor(nativeId);
    this.outdoorSensors.set(nativeId, sensor);
    return sensor;
  }

  /**
   * Get outdoor sensor for use by AC unit
   */
  getOutdoorSensor(nativeId: string): MHIOutdoorSensor | undefined {
    return this.outdoorSensors.get(nativeId);
  }

  async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
    if (!nativeId) return;

    // Stop polling for AC units
    const unit = this.devices.get(nativeId);
    if (unit) {
      unit.stopPolling();
      this.devices.delete(nativeId);
    }

    // Remove outdoor sensors
    this.outdoorSensors.delete(`${nativeId}-outdoor`);
  }

  // ============================================
  // Settings Interface
  // ============================================

  async getSettings(): Promise<Setting[]> {
    const storage = this.getStorage();
    const devices = storage.devices || [];
    const lastDiscovery = this.storage.getItem('lastDiscovery') || '';

    const settings: Setting[] = [
      {
        key: 'pollingInterval',
        title: 'Polling Interval',
        description: 'How often to poll device status (in seconds)',
        type: 'number',
        value: storage.pollingInterval || DEFAULT_POLLING_INTERVAL,
        range: [5, 60],
      },
      {
        group: 'Discovery',
        key: 'scanSubnet',
        title: 'Scan Network',
        description: 'Enter "AUTO" to detect subnets automatically, or enter a subnet manually (e.g., "192.168.1"). Updates IP if device moved.',
        type: 'string',
        value: '',
        placeholder: 'AUTO',
      },
      {
        group: 'Discovery',
        key: 'lastDiscoveryResult',
        title: 'Last Discovery Result',
        type: 'string',
        readonly: true,
        value: lastDiscovery || 'No scan performed yet',
      },
      {
        group: 'Discovery',
        key: 'addByIp',
        title: 'Add Device by IP',
        description: 'Enter IP address to add a specific device',
        type: 'string',
        value: '',
        placeholder: '192.168.1.100',
      },
      {
        group: 'Devices',
        key: 'deviceCount',
        title: 'Configured Devices',
        description: `${devices.length} device(s) configured`,
        type: 'string',
        readonly: true,
        value: devices.map(d => `${d.name} (${d.ip})`).join(', ') || 'None',
      },
      {
        group: 'Devices',
        key: 'addDevice',
        title: 'Add Device Manually',
        description: 'Add a new AC unit. Format: name,ip,mac (e.g., "Living Room,192.168.1.100,1234567890ab")',
        type: 'string',
        value: '',
        placeholder: 'name,ip,mac',
      },
      {
        group: 'Devices',
        key: 'removeDevice',
        title: 'Remove Device',
        description: 'Enter MAC address to remove a device',
        type: 'string',
        value: '',
        placeholder: 'MAC address (e.g., 1234567890ab)',
      },
    ];

    // Add individual device entries for editing
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      settings.push({
        group: 'Devices',
        subgroup: device.name,
        key: `device_${i}_name`,
        title: 'Name',
        type: 'string',
        value: device.name,
      });
      settings.push({
        group: 'Devices',
        subgroup: device.name,
        key: `device_${i}_ip`,
        title: 'IP Address',
        type: 'string',
        value: device.ip,
      });
      settings.push({
        group: 'Devices',
        subgroup: device.name,
        key: `device_${i}_mac`,
        title: 'MAC Address',
        type: 'string',
        value: device.mac,
        readonly: true,
      });
    }

    return settings;
  }

  async putSetting(key: string, value: string | number): Promise<void> {
    const storage = this.getStorage();

    if (key === 'pollingInterval') {
      const interval = Math.max(5, Math.min(60, Number(value)));
      this.setStorageItem('pollingInterval', String(interval));
      this.console.log(`Polling interval updated to ${interval}s`);

      // Update all existing devices
      for (const unit of this.devices.values()) {
        unit.updateConfig({ pollingInterval: interval });
      }

    } else if (key === 'scanSubnet') {
      await this.scanSubnet(String(value));

    } else if (key === 'addByIp') {
      await this.autoRegisterDevice(String(value));

    } else if (key === 'addDevice') {
      await this.addDevice(String(value));

    } else if (key === 'removeDevice') {
      await this.removeDevice(String(value));

    } else if (key.startsWith('device_')) {
      // Handle individual device edits
      const match = key.match(/device_(\d+)_(name|ip)/);
      if (match) {
        const index = parseInt(match[1]);
        const field = match[2] as 'name' | 'ip';
        const devices = storage.devices || [];

        if (index < devices.length) {
          devices[index][field] = String(value);
          this.setStorageItem('devices', JSON.stringify(devices));

          // Re-discover to update device names
          if (field === 'name') {
            await this.discoverDevices();
          }

          // Update unit config if IP changed
          if (field === 'ip') {
            const device = devices[index];
            const nativeId = `mhi-${device.mac}`;
            const unit = this.devices.get(nativeId);
            if (unit) {
              await unit.putSetting('ip', String(value));
            }
          }
        }
      }
    }
  }

  /**
   * Detect local subnets from network interfaces
   */
  private getLocalSubnets(): string[] {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const subnets: string[] = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        // Skip loopback and non-IPv4
        if (iface.family !== 'IPv4' || iface.internal) continue;

        // Extract subnet (first 3 octets)
        const parts = iface.address.split('.');
        if (parts.length === 4) {
          const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
          if (!subnets.includes(subnet)) {
            subnets.push(subnet);
          }
        }
      }
    }

    return subnets;
  }

  /**
   * Scan a subnet for MHI devices and auto-add them
   */
  private async scanSubnet(subnet: string): Promise<void> {
    if (!subnet || !subnet.trim()) return;

    subnet = subnet.trim().toUpperCase();

    // Handle AUTO detection
    if (subnet === 'AUTO') {
      const subnets = this.getLocalSubnets();
      if (subnets.length === 0) {
        this.console.error('Could not detect any local subnets');
        this.storage.setItem('lastDiscovery', 'Error: No local subnets detected');
        return;
      }

      this.console.log(`Auto-detected subnets: ${subnets.join(', ')}`);

      // Scan all detected subnets
      let totalFound = 0;
      let totalAdded = 0;
      let totalUpdated = 0;

      for (const s of subnets) {
        const result = await this.scanSingleSubnet(s);
        totalFound += result.found;
        totalAdded += result.added;
        totalUpdated += result.updated;
      }

      const summary = `Scan complete: found ${totalFound}, added ${totalAdded}, updated ${totalUpdated}`;
      this.storage.setItem('lastDiscovery', summary);
      this.console.log(summary);
      return;
    }

    // Validate subnet format (e.g., "192.168.1" or "10.2.2")
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(subnet)) {
      this.console.error('Invalid subnet format. Use "AUTO" or format like "192.168.1"');
      this.storage.setItem('lastDiscovery', 'Error: Invalid subnet format. Use AUTO or x.x.x');
      return;
    }

    const result = await this.scanSingleSubnet(subnet);
    const summary = `Scan complete: found ${result.found}, added ${result.added}, updated ${result.updated}`;
    this.storage.setItem('lastDiscovery', summary);
    this.console.log(summary);
  }

  /**
   * Scan a single subnet
   */
  private async scanSingleSubnet(subnet: string): Promise<{ found: number; added: number; updated: number }> {
    this.console.log(`Scanning ${subnet}.1-254 for MHI devices...`);
    this.storage.setItem('lastDiscovery', `Scanning ${subnet}...`);

    try {
      const found = await discoverDevices(subnet, 1, 254, 30);

      if (found.length === 0) {
        this.console.log(`No MHI devices found on ${subnet}`);
        return { found: 0, added: 0, updated: 0 };
      }

      this.console.log(`Found ${found.length} device(s) on ${subnet}`);
      for (const d of found) {
        this.console.log(`  - ${d.ip} (MAC: ${d.mac})`);
      }

      // Auto-register and add each discovered device
      let added = 0;
      let updated = 0;
      for (const device of found) {
        const result = await this.autoRegisterDevice(device.ip, true);
        if (result === 'added') {
          added++;
        } else if (result === 'updated') {
          updated++;
        }
      }

      // Discover devices in Scrypted after adding
      if (added > 0) {
        await this.discoverDevices();
      }

      return { found: found.length, added, updated };

    } catch (error) {
      this.console.error('Scan failed:', error);
      return { found: 0, added: 0, updated: 0 };
    }
  }

  /**
   * Auto-register as operator and add device
   * @param ip IP address of the device
   * @param fromScan If true, called from scan (skip redundant probe, defer discovery)
   * @returns 'added' if new device, 'updated' if IP changed, 'skipped' if no change
   */
  private async autoRegisterDevice(ip: string, fromScan: boolean = false): Promise<'added' | 'updated' | 'skipped'> {
    if (!ip || !ip.trim()) return 'skipped';

    ip = ip.trim();

    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      this.console.error('Invalid IP address format');
      return 'skipped';
    }

    this.console.log(`Auto-registering with device at ${ip}...`);

    try {
      // Probe to get the MAC address
      const device = await probeDevice(ip);

      if (!device) {
        this.console.error(`No MHI device found at ${ip}`);
        return 'skipped';
      }

      // Check if device already exists
      const storage = this.getStorage();
      const devices = storage.devices || [];

      const existingIndex = devices.findIndex(d => d.mac.toLowerCase() === device.mac.toLowerCase());

      if (existingIndex >= 0) {
        const existing = devices[existingIndex];

        // Check if IP has changed
        if (existing.ip !== ip) {
          this.console.log(`Device ${device.mac} IP changed: ${existing.ip} → ${ip}`);
          devices[existingIndex].ip = ip;
          this.storage.setItem('devices', JSON.stringify(devices));

          // Update the running device instance if exists
          const nativeId = `mhi-${device.mac.toLowerCase()}`;
          const unit = this.devices.get(nativeId);
          if (unit) {
            unit.updateConfig({ ip });
          }

          return 'updated';
        }

        // Same IP, no change needed
        return 'skipped';
      }

      this.console.log(`Found new device: MAC ${device.mac}`);

      // Check if we already have an operator ID, or generate a new one
      let operatorId = this.storage.getItem('operatorId');

      if (!operatorId) {
        operatorId = generateUUID();
        this.console.log(`Generated new operator ID: ${operatorId}`);
      }

      // Register with the device
      const registered = await registerOperator(ip, device.mac, operatorId, 'Scrypted');

      if (!registered) {
        this.console.error('Failed to register operator ID with device');
        return 'skipped';
      }

      this.console.log('Successfully registered as operator "Scrypted"');

      // Save the operator ID
      this.storage.setItem('operatorId', operatorId);

      // Add the device with auto-generated name
      const name = `AC ${device.mac.slice(-4).toUpperCase()}`;
      devices.push({
        name,
        ip: device.ip,
        mac: device.mac.toLowerCase(),
      });

      this.storage.setItem('devices', JSON.stringify(devices));
      this.console.log(`Added device: ${name} (${ip})`);

      // Re-discover devices (unless called from scan, which does it at the end)
      if (!fromScan) {
        await this.discoverDevices();
      }

      return 'added';

    } catch (error) {
      this.console.error('Auto-registration failed:', error);
      return 'skipped';
    }
  }

  /**
   * Add a new device from settings input
   */
  private async addDevice(input: string): Promise<void> {
    if (!input || !input.trim()) return;

    const parts = input.split(',').map(s => s.trim());
    if (parts.length !== 3) {
      this.console.error('Invalid device format. Use: name,ip,mac');
      return;
    }

    const [name, ip, mac] = parts;

    // Validate MAC address (12 hex characters)
    if (!/^[a-f0-9]{12}$/i.test(mac)) {
      this.console.error('Invalid MAC address. Must be 12 hex characters (e.g., 1234567890ab)');
      return;
    }

    // Validate IP address
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      this.console.error('Invalid IP address format');
      return;
    }

    const storage = this.getStorage();
    const devices = storage.devices || [];

    // Check for duplicate MAC
    if (devices.some(d => d.mac.toLowerCase() === mac.toLowerCase())) {
      this.console.error('Device with this MAC address already exists');
      return;
    }

    // Add device
    devices.push({
      name,
      ip,
      mac: mac.toLowerCase(),
    });

    this.setStorageItem('devices', JSON.stringify(devices));
    this.console.log(`Added device: ${name} (${ip})`);

    // Re-discover devices
    await this.discoverDevices();
  }

  /**
   * Remove a device by MAC address
   */
  private async removeDevice(mac: string): Promise<void> {
    if (!mac || !mac.trim()) return;

    mac = mac.trim().toLowerCase();

    const storage = this.getStorage();
    const devices = storage.devices || [];

    const index = devices.findIndex(d => d.mac.toLowerCase() === mac);
    if (index === -1) {
      this.console.error(`Device with MAC ${mac} not found`);
      return;
    }

    const removed = devices.splice(index, 1)[0];
    this.setStorageItem('devices', JSON.stringify(devices));

    // Clean up device instances
    const nativeId = `mhi-${mac}`;
    const unit = this.devices.get(nativeId);
    if (unit) {
      unit.stopPolling();
      this.devices.delete(nativeId);
    }
    this.outdoorSensors.delete(`${nativeId}-outdoor`);

    this.console.log(`Removed device: ${removed.name}`);

    // Re-discover devices
    await this.discoverDevices();
  }
}

export default MHISmartMAirProvider;
