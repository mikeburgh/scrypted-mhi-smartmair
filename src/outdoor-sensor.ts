/**
 * Outdoor Temperature Sensor Device
 *
 * A read-only temperature sensor that displays the outdoor temperature
 * reported by the AC unit's outdoor condenser.
 */

import sdk, {
  ScryptedDeviceBase,
  Thermometer,
  TemperatureUnit,
} from '@scrypted/sdk';

export class MHIOutdoorSensor extends ScryptedDeviceBase implements Thermometer {
  constructor(nativeId: string) {
    super(nativeId);

    // Initialize temperature to undefined until we get a reading
    this.temperature = undefined;
    this.temperatureUnit = TemperatureUnit.C;
  }

  /**
   * Update the temperature reading
   * Called by the parent AC unit when it polls status
   */
  updateTemperature(tempCelsius: number): void {
    if (this.temperature !== tempCelsius) {
      this.temperature = tempCelsius;
      this.console.log(`Outdoor temperature updated: ${tempCelsius}°C`);
    }
  }

  /**
   * Set the display unit for temperature
   */
  async setTemperatureUnit(unit: TemperatureUnit): Promise<void> {
    this.temperatureUnit = unit;
  }
}
