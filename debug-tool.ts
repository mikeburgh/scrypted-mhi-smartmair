#!/usr/bin/env npx ts-node
/**
 * MHI WF-RAC Debug Tool
 *
 * Standalone tool to debug and calibrate AC unit communication
 * Run with: npx ts-node debug-tool.ts <ip-address>
 */

import axios from 'axios';
import * as readline from 'readline';

const PORT = 51443;

interface AirconStatResponse {
  apiVer: string;
  command: string;
  deviceId: string;
  operatorId: string;
  timestamp: number;
  result: number;
  contents: {
    airconStat: string;
    airconId: string;
    electric: number;
    errorCode: string;
    outdoorTemp?: number;
    indoorTemp?: number;
    firmType?: string;
    wireless?: { firmVer: string };
    mcu?: { firmVer: string };
  };
}

class DebugTool {
  private ip: string;
  private operatorId: string = 'DEBUG-TOOL-001';
  private deviceId: string = '';
  private lastBuffer: Buffer | null = null;

  constructor(ip: string) {
    this.ip = ip;
  }

  private get baseUrl(): string {
    return `http://${this.ip}:${PORT}/beaver/command`;
  }

  private get timestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  async getDeviceInfo(): Promise<any> {
    const response = await axios.post(this.baseUrl, {
      apiVer: '1.0',
      command: 'getDeviceInfo',
      deviceId: 'discovery',
      operatorId: 'discovery',
      timestamp: this.timestamp,
    }, { timeout: 10000 });

    this.deviceId = response.data.contents?.airconId || '';
    return response.data;
  }

  async getStatus(): Promise<AirconStatResponse> {
    const response = await axios.post<AirconStatResponse>(this.baseUrl, {
      apiVer: '1.0',
      command: 'getAirconStat',
      deviceId: this.deviceId,
      operatorId: this.operatorId,
      timestamp: this.timestamp,
    }, { timeout: 10000 });

    if (response.data.contents?.airconStat) {
      this.lastBuffer = Buffer.from(response.data.contents.airconStat, 'base64');
    }

    return response.data;
  }

  async setStatus(buffer: Buffer): Promise<any> {
    const airconStat = buffer.toString('base64');

    const response = await axios.post(this.baseUrl, {
      apiVer: '1.0',
      command: 'setAirconStat',
      deviceId: this.deviceId,
      operatorId: this.operatorId,
      timestamp: this.timestamp,
      contents: {
        airconId: this.deviceId,
        airconStat,
      },
    }, { timeout: 10000 });

    return response.data;
  }

  parseStatus(buffer: Buffer): void {
    console.log('\n=== RAW BUFFER ===');
    console.log('Full hex:', buffer.toString('hex'));
    console.log('Length:', buffer.length, 'bytes');

    console.log('\n=== COMMAND SECTION (bytes 0-17) ===');
    const cmdSection = buffer.slice(0, 18);
    console.log('Hex:', cmdSection.toString('hex'));

    const byte2 = buffer[2];
    console.log(`\nByte 2: 0x${byte2.toString(16).padStart(2, '0')} = ${byte2.toString(2).padStart(8, '0')} binary`);
    console.log(`  Power (bit 0): ${byte2 & 0x01 ? 'ON' : 'OFF'}`);
    console.log(`  Bits 0-1: ${byte2 & 0x03}`);
    console.log(`  Bits 2-4: ${(byte2 >> 2) & 0x07} (shift 2)`);
    console.log(`  Bits 3-5: ${(byte2 >> 3) & 0x07} (shift 3 - homebridge mode)`);
    console.log(`  Bits 4-6: ${(byte2 >> 4) & 0x07} (shift 4 - your device mode)`);
    console.log(`  Bits 5-7: ${(byte2 >> 5) & 0x07} (shift 5)`);

    const byte3 = buffer[3];
    console.log(`\nByte 3: 0x${byte3.toString(16).padStart(2, '0')} = ${byte3.toString(2).padStart(8, '0')} binary`);
    console.log(`  Airflow (bits 0-3): ${byte3 & 0x0F}`);

    const byte4 = buffer[4];
    const temp = (byte4 - 128) * 0.5;
    console.log(`\nByte 4: 0x${byte4.toString(16).padStart(2, '0')} = ${byte4}`);
    console.log(`  Temperature: ${temp}°C (formula: (${byte4} - 128) * 0.5)`);

    console.log('\n=== STATUS SECTION (bytes 25-42) ===');
    const statSection = buffer.slice(25, 43);
    console.log('Hex:', statSection.toString('hex'));
    console.log(`Status byte 2 (offset 27): 0x${buffer[27]?.toString(16).padStart(2, '0')}`);
    console.log(`Status byte 3 (offset 28): 0x${buffer[28]?.toString(16).padStart(2, '0')}`);

    // Indoor temp at byte 28 (in status section = offset 25 + 3)
    const indoorTempByte = buffer[28];
    if (indoorTempByte) {
      console.log(`\nIndoor temp byte (offset 28): ${indoorTempByte} → ${indoorTempByte - 0.5}°C`);
    }

    // Find outdoor temp marker
    console.log('\n=== OUTDOOR TEMP ===');
    for (let i = 0; i < buffer.length - 2; i++) {
      if (buffer[i] === 0x80 && buffer[i + 1] === 0x10) {
        const rawByte = buffer[i + 2];
        const temp = Math.round(((rawByte & 0xff) - 36) * 0.16 * 10) / 10;
        console.log(`Found marker 0x80 0x10 at offset ${i}`);
        console.log(`Raw byte: ${rawByte} → ${temp}°C (formula: (${rawByte} - 36) * 0.16)`);
        break;
      }
    }
  }

  // CRC-16-CCITT
  private crc16ccitt(data: Buffer): number {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc <<= 1;
        }
        crc &= 0xFFFF;
      }
    }
    return crc;
  }

  private pendingBuffer: Buffer | null = null;

  prepareBuffer(byte2Value?: number, byte4Value?: number): Buffer | null {
    if (!this.lastBuffer || this.lastBuffer.length < 50) {
      console.log('No buffer available - get status first');
      return null;
    }

    const result = Buffer.alloc(50);
    this.lastBuffer.copy(result, 0, 0, 50);

    if (byte2Value !== undefined) {
      result[2] = byte2Value;
    }
    if (byte4Value !== undefined) {
      result[4] = byte4Value;
    }

    // Recalculate command CRC
    const crc = this.crc16ccitt(result.slice(0, 23));
    result[23] = crc & 0xFF;
    result[24] = (crc >> 8) & 0xFF;

    this.pendingBuffer = result;
    return result;
  }

  async sendPending(): Promise<any> {
    if (!this.pendingBuffer) {
      console.log('No pending buffer - use b2 or t command first');
      return null;
    }
    const result = await this.setStatus(this.pendingBuffer);
    this.pendingBuffer = null;
    return result;
  }

  // Helper to set power + mode
  // Mode is in bits 2-4: 0=Auto, 1=Dry, 2=Cool, 3=Fan, 4=Heat
  prepareModeChange(power: boolean, modeValue: number): Buffer | null {
    if (!this.lastBuffer) return null;

    // Current byte2
    let byte2 = this.lastBuffer[2];
    // Clear bits 0-4, keep bits 5-7
    byte2 &= 0xE0; // 11100000
    // Set power: bit 0 = on/off, bit 1 also set for on
    byte2 |= power ? 0x03 : 0x02;
    // Set mode in bits 2-4
    byte2 |= (modeValue << 2);

    return this.prepareBuffer(byte2);
  }
}

async function main() {
  const ip = process.argv[2];

  if (!ip) {
    console.log('Usage: npx ts-node debug-tool.ts <ip-address>');
    console.log('Example: npx ts-node debug-tool.ts 10.2.2.75');
    process.exit(1);
  }

  console.log(`\nMHI WF-RAC Debug Tool`);
  console.log(`======================`);
  console.log(`Connecting to ${ip}:${PORT}...\n`);

  const tool = new DebugTool(ip);

  try {
    // Get device info
    console.log('Getting device info...');
    const info = await tool.getDeviceInfo();
    console.log('Device ID:', info.contents?.airconId);
    console.log('Result:', info.result);

    // Get initial status
    console.log('\nGetting current status...');
    const status = await tool.getStatus();
    console.log('Result:', status.result);
    console.log('Firmware:', status.contents?.firmType, status.contents?.wireless?.firmVer);

    if (status.contents?.airconStat) {
      const buffer = Buffer.from(status.contents.airconStat, 'base64');
      tool.parseStatus(buffer);
    }

    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      console.log('\n=== COMMANDS ===');
      console.log('  r            - Refresh status from device');
      console.log('  on           - Turn ON (keeps current mode)');
      console.log('  off          - Turn OFF');
      console.log('  cool         - Set mode to Cool + ON');
      console.log('  heat         - Set mode to Heat + ON');
      console.log('  auto         - Set mode to Auto + ON');
      console.log('  fan          - Set mode to Fan + ON');
      console.log('  dry          - Set mode to Dry + ON');
      console.log('  t NN         - Set temperature to NN°C (e.g., "t 24")');
      console.log('  b2 XX        - Set byte2 to raw hex (e.g., "b2 93")');
      console.log('  send         - Send pending command to device');
      console.log('  calibrate    - Start mode calibration wizard');
      console.log('  q            - Quit');

      rl.question('\n> ', async (input) => {
        const parts = input.trim().toLowerCase().split(' ');
        const cmd = parts[0];

        try {
          if (cmd === 'q' || cmd === 'quit') {
            rl.close();
            process.exit(0);

          } else if (cmd === 'r' || cmd === 'refresh') {
            const status = await tool.getStatus();
            console.log('Result:', status.result);
            if (status.contents?.airconStat) {
              const buffer = Buffer.from(status.contents.airconStat, 'base64');
              tool.parseStatus(buffer);
            }

          } else if (cmd === 'on') {
            const status = await tool.getStatus();
            if (status.contents?.airconStat) {
              const buf = Buffer.from(status.contents.airconStat, 'base64');
              const currentMode = (buf[2] >> 4) & 0x07;
              tool.prepareModeChange(true, currentMode);
              console.log('Prepared: Power ON, keeping current mode');
              console.log('Use "send" to apply');
            }

          } else if (cmd === 'off') {
            const status = await tool.getStatus();
            if (status.contents?.airconStat) {
              const buf = Buffer.from(status.contents.airconStat, 'base64');
              const currentMode = (buf[2] >> 4) & 0x07;
              tool.prepareModeChange(false, currentMode);
              console.log('Prepared: Power OFF');
              console.log('Use "send" to apply');
            }

          } else if (['cool', 'heat', 'auto', 'fan', 'dry'].includes(cmd)) {
            // Mode values (bits 2-4): 0=Auto, 1=Dry, 2=Cool, 3=Fan, 4=Heat
            const modeMap: Record<string, number> = {
              auto: 0, dry: 1, cool: 2, fan: 3, heat: 4
            };
            const buffer = tool.prepareModeChange(true, modeMap[cmd]);
            if (buffer) {
              console.log(`Prepared: ${cmd.toUpperCase()} mode + ON`);
              console.log(`byte2 will be: 0x${buffer[2].toString(16)}`);
              console.log('Use "send" to apply');
            }

          } else if (cmd === 't' && parts[1]) {
            const temp = parseFloat(parts[1]);
            if (isNaN(temp) || temp < 18 || temp > 30) {
              console.log('Invalid temperature (18-30)');
            } else {
              const byte4 = Math.round(temp / 0.5) + 128;
              const buffer = tool.prepareBuffer(undefined, byte4);
              if (buffer) {
                console.log(`Prepared: Temperature ${temp}°C (byte4 = 0x${byte4.toString(16)})`);
                console.log('Use "send" to apply');
              }
            }

          } else if (cmd === 'b2' && parts[1]) {
            const byte2 = parseInt(parts[1], 16);
            if (isNaN(byte2)) {
              console.log('Invalid hex value');
            } else {
              const buffer = tool.prepareBuffer(byte2);
              if (buffer) {
                console.log(`Prepared: byte2 = 0x${byte2.toString(16)}`);
                tool.parseStatus(buffer);
                console.log('Use "send" to apply');
              }
            }

          } else if (cmd === 'send') {
            console.log('Sending to device...');
            const result = await tool.sendPending();
            if (result) {
              console.log('Result:', result.result);
              if (result.result === 0 || result.result === 1 || result.result === 12) {
                console.log('SUCCESS!');
                // Refresh to show new state
                const status = await tool.getStatus();
                if (status.contents?.airconStat) {
                  const buffer = Buffer.from(status.contents.airconStat, 'base64');
                  tool.parseStatus(buffer);
                }
              } else {
                console.log('FAILED - result:', result.result);
              }
            }

          } else if (cmd === 'calibrate') {
            console.log('\n=== MODE CALIBRATION WIZARD ===');
            console.log('This will automatically detect mode changes as you set them in the Smart M app.');
            console.log('Temperature changes are ignored - only mode/power changes are captured.');
            console.log('\n⚠️  Make sure the AC unit is turned ON before starting!\n');

            const modes = ['Cool', 'Heat', 'Auto', 'Fan', 'Dry', 'Off'];
            const captures: Record<string, Buffer> = {};

            // Bytes to ignore when detecting changes (temperature-related)
            // Byte 4: setpoint temp, Byte 28: indoor temp, Bytes 50+: outdoor/sensor data
            const ignoreBytes = new Set([4, 28, 50, 51, 52, 53, 54, 55, 56, 57]);

            // Helper to check if buffers differ in significant bytes
            const hasSignificantChange = (oldBuf: Buffer, newBuf: Buffer): boolean => {
              // Check first 25 bytes (command section) excluding temp bytes
              for (let i = 0; i < 25; i++) {
                if (ignoreBytes.has(i)) continue;
                if (oldBuf[i] !== newBuf[i]) return true;
              }
              return false;
            };

            // Get initial reference buffer
            console.log('Getting initial state...');
            let status = await tool.getStatus();
            let referenceBuffer = status.contents?.airconStat
              ? Buffer.from(status.contents.airconStat, 'base64')
              : null;

            if (!referenceBuffer) {
              console.log('Failed to get initial state');
              prompt();
              return;
            }

            // First, ask current mode
            await new Promise<void>((resolve) => {
              rl.question('What mode is the AC currently in? (or press Enter to skip): ', async (current) => {
                if (current.trim()) {
                  captures[current.trim()] = Buffer.from(referenceBuffer!);
                  console.log(`  Captured current state as "${current.trim()}"`);
                  console.log(`    byte2 = 0x${referenceBuffer![2].toString(16).padStart(2, '0')}`);
                }
                resolve();
              });
            });

            console.log('\nNow set each mode using the Smart M app.');
            console.log('The tool will automatically detect when the mode changes.\n');

            for (const mode of modes) {
              // Skip if already captured
              if (captures[mode]) {
                console.log(`  ${mode} already captured, skipping...`);
                continue;
              }

              console.log(`📱 Set AC to ${mode} in Smart M app... (or type 's' + Enter to skip)`);

              // Poll for change
              let captured = false;
              let skipRequested = false;
              let lineHandler: ((input: string) => void) | null = null;

              // Set up skip listener
              const skipPromise = new Promise<void>((resolve) => {
                lineHandler = (input: string) => {
                  if (input.trim().toLowerCase() === 's') {
                    skipRequested = true;
                    resolve();
                  }
                };
                rl.once('line', lineHandler);
              });

              // Poll until change detected or skip
              const pollPromise = (async () => {
                while (!captured && !skipRequested) {
                  await new Promise(r => setTimeout(r, 1500)); // Poll every 1.5 seconds

                  try {
                    const newStatus = await tool.getStatus();
                    if (!newStatus.contents?.airconStat) continue;

                    const newBuffer = Buffer.from(newStatus.contents.airconStat, 'base64');

                    if (hasSignificantChange(referenceBuffer!, newBuffer)) {
                      captures[mode] = newBuffer;
                      captured = true;
                      console.log(`  ✓ Detected ${mode}! byte2 = 0x${newBuffer[2].toString(16).padStart(2, '0')}`);
                      referenceBuffer = newBuffer; // Update reference for next mode
                    }
                  } catch (e) {
                    // Ignore poll errors, keep trying
                  }
                }
              })();

              await Promise.race([skipPromise, pollPromise]);

              // Clean up listener if poll succeeded
              if (lineHandler && captured) {
                rl.removeListener('line', lineHandler);
              }

              if (skipRequested && !captured) {
                console.log(`  Skipped ${mode}`);
              }
            }

            // Analyze differences
            console.log('\n=== BUFFER COMPARISON ===');
            console.log('Comparing first 25 bytes (command section) across modes:\n');

            const modeNames = Object.keys(captures);
            if (modeNames.length < 2) {
              console.log('Need at least 2 modes to compare.');
            } else {
              // Find bytes that differ between any modes
              const differingBytes: Map<number, Map<string, number>> = new Map();

              for (let i = 0; i < 25; i++) {
                const values = new Map<string, number>();
                let hasDiff = false;
                let firstVal: number | null = null;

                for (const mode of modeNames) {
                  const val = captures[mode][i];
                  values.set(mode, val);
                  if (firstVal === null) firstVal = val;
                  else if (val !== firstVal) hasDiff = true;
                }

                if (hasDiff) {
                  differingBytes.set(i, values);
                }
              }

              if (differingBytes.size === 0) {
                console.log('No differences found in command section!');
                console.log('This might mean modes were not actually changing.');
              } else {
                console.log('Bytes that differ between modes:');
                console.log('─'.repeat(60));

                // Header
                let header = 'Byte  │';
                for (const mode of modeNames) {
                  header += ` ${mode.padEnd(8)} │`;
                }
                console.log(header);
                console.log('─'.repeat(60));

                // Data rows
                for (const [byteIdx, values] of differingBytes) {
                  let row = `  ${byteIdx.toString().padStart(2)}  │`;
                  for (const mode of modeNames) {
                    const val = values.get(mode)!;
                    row += ` 0x${val.toString(16).padStart(2, '0')}     │`;
                  }
                  console.log(row);

                  // Also show binary for byte 2 specifically
                  if (byteIdx === 2) {
                    let binRow = '  bin │';
                    for (const mode of modeNames) {
                      const val = values.get(mode)!;
                      binRow += ` ${val.toString(2).padStart(8, '0').slice(0,4)} ${val.toString(2).padStart(8, '0').slice(4)} │`;
                    }
                    console.log(binRow);
                  }
                }
                console.log('─'.repeat(60));
              }

              // Show full byte 2 analysis for each mode
              console.log('\n=== BYTE 2 ANALYSIS ===');
              for (const mode of modeNames) {
                const byte2 = captures[mode][2];
                console.log(`${mode}:`);
                console.log(`  byte2 = 0x${byte2.toString(16).padStart(2, '0')} = ${byte2.toString(2).padStart(8, '0')}`);
                console.log(`  bit 0 (power): ${byte2 & 1}`);
                console.log(`  bits 0-1: ${byte2 & 0x03}`);
                console.log(`  bits 2-4: ${(byte2 >> 2) & 0x07}`);
                console.log(`  bits 3-5: ${(byte2 >> 3) & 0x07}`);
                console.log(`  bits 4-6: ${(byte2 >> 4) & 0x07}`);
                console.log(`  bits 5-7: ${(byte2 >> 5) & 0x07}`);
                console.log('');
              }

              // Generate calibration JSON
              console.log('\n=== CALIBRATION DATA ===');
              const modeValues: Record<string, number> = {};
              for (const mode of modeNames) {
                const byte2 = captures[mode][2];
                // Extract mode value from bits 2-4
                const modeVal = (byte2 >> 2) & 0x07;
                modeValues[mode.toLowerCase()] = modeVal;
              }
              console.log('Mode values (bits 2-4):');
              console.log(JSON.stringify(modeValues, null, 2));
            }

            // === FAN SPEED CALIBRATION ===
            const doFanSpeed = await new Promise<boolean>((resolve) => {
              rl.question('\nCalibrate fan speeds? (y/n): ', (answer) => {
                resolve(answer.trim().toLowerCase() === 'y');
              });
            });

            const fanCaptures: Record<string, Buffer> = {};

            if (doFanSpeed) {
              console.log('\n=== FAN SPEED CALIBRATION ===');
              console.log('First, set fan to AUTO in the Smart M app (cycle through all speeds).');
              console.log('Then we\'ll capture each speed as you cycle through them.\n');

              const fanSpeeds = ['Auto', '1-bar', '2-bar', '3-bar', '4-bar'];

              // Get fresh reference
              let fanStatus = await tool.getStatus();
              let fanReference = fanStatus.contents?.airconStat
                ? Buffer.from(fanStatus.contents.airconStat, 'base64')
                : null;

              if (fanReference) {
                // Ask current fan speed
                await new Promise<void>((resolve) => {
                  rl.question('What fan speed is it currently at? (or Enter to skip): ', async (current) => {
                    if (current.trim()) {
                      fanCaptures[current.trim()] = Buffer.from(fanReference!);
                      console.log(`  Captured current fan speed as "${current.trim()}"`);
                      console.log(`    byte3 = 0x${fanReference![3].toString(16).padStart(2, '0')}`);
                    }
                    resolve();
                  });
                });

                for (const speed of fanSpeeds) {
                  if (fanCaptures[speed]) {
                    console.log(`  ${speed} already captured, skipping...`);
                    continue;
                  }

                  console.log(`📱 Set fan to ${speed} in Smart M app... (or 's' to skip)`);

                  let captured = false;
                  let skipRequested = false;
                  let lineHandler: ((input: string) => void) | null = null;

                  const skipPromise = new Promise<void>((resolve) => {
                    lineHandler = (input: string) => {
                      if (input.trim().toLowerCase() === 's') {
                        skipRequested = true;
                        resolve();
                      }
                    };
                    rl.once('line', lineHandler);
                  });

                  const pollPromise = (async () => {
                    while (!captured && !skipRequested) {
                      await new Promise(r => setTimeout(r, 1500));
                      try {
                        const newStatus = await tool.getStatus();
                        if (!newStatus.contents?.airconStat) continue;
                        const newBuffer = Buffer.from(newStatus.contents.airconStat, 'base64');

                        // Check byte 3 for fan speed changes
                        if (newBuffer[3] !== fanReference![3]) {
                          fanCaptures[speed] = newBuffer;
                          captured = true;
                          console.log(`  ✓ Detected ${speed}! byte3 = 0x${newBuffer[3].toString(16).padStart(2, '0')}`);
                          fanReference = newBuffer;
                        }
                      } catch (e) { }
                    }
                  })();

                  await Promise.race([skipPromise, pollPromise]);

                  // Clean up listener if poll succeeded
                  if (lineHandler && captured) {
                    rl.removeListener('line', lineHandler);
                  }

                  if (skipRequested && !captured) console.log(`  Skipped ${speed}`);
                }

                // Show fan speed results
                const fanSpeedNames = Object.keys(fanCaptures);
                if (fanSpeedNames.length >= 2) {
                  console.log('\n=== FAN SPEED ANALYSIS ===');
                  const fanValues: Record<string, number> = {};
                  for (const speed of fanSpeedNames) {
                    const byte3 = fanCaptures[speed][3];
                    const fanVal = byte3 & 0x0F;
                    fanValues[speed.toLowerCase()] = fanVal;
                    console.log(`${speed}: byte3 = 0x${byte3.toString(16).padStart(2, '0')}, bits 0-3 = ${fanVal}`);
                  }
                  console.log('\nFan speed values (bits 0-3):');
                  console.log(JSON.stringify(fanValues, null, 2));
                }
              }
            }

            // === HORIZONTAL SWING CALIBRATION ===
            const doHSwing = await new Promise<boolean>((resolve) => {
              rl.question('\nCalibrate horizontal swing (left/right)? (y/n): ', (answer) => {
                resolve(answer.trim().toLowerCase() === 'y');
              });
            });

            const hSwingCaptures: Record<string, Buffer> = {};

            if (doHSwing) {
              console.log('\n=== HORIZONTAL SWING CALIBRATION ===');
              console.log('First, set horizontal to SWING mode in the Smart M app.');
              console.log('Then we\'ll capture each position as you set them.\n');

              const hPositions = ['Swing', 'Left-Left', 'Left-Center', 'Center', 'Center-Right', 'Right-Right'];

              let hStatus = await tool.getStatus();
              let hReference = hStatus.contents?.airconStat
                ? Buffer.from(hStatus.contents.airconStat, 'base64')
                : null;

              if (hReference) {
                await new Promise<void>((resolve) => {
                  rl.question('What horizontal position is it currently at? (or Enter to skip): ', async (current) => {
                    if (current.trim()) {
                      hSwingCaptures[current.trim()] = Buffer.from(hReference!);
                      console.log(`  Captured as "${current.trim()}", byte5 = 0x${hReference![5].toString(16).padStart(2, '0')}`);
                    }
                    resolve();
                  });
                });

                // Bytes to ignore when detecting swing changes (mode, fan, temp, CRC)
                const hIgnoreBytes = new Set([2, 3, 4, 23, 24]);

                for (const pos of hPositions) {
                  if (hSwingCaptures[pos]) {
                    console.log(`  ${pos} already captured, skipping...`);
                    continue;
                  }

                  console.log(`📱 Set horizontal swing to ${pos}... (or 's' to skip)`);

                  let captured = false;
                  let skipRequested = false;
                  let lineHandler: ((input: string) => void) | null = null;

                  const skipPromise = new Promise<void>((resolve) => {
                    lineHandler = (input: string) => {
                      if (input.trim().toLowerCase() === 's') {
                        skipRequested = true;
                        resolve();
                      }
                    };
                    rl.once('line', lineHandler);
                  });

                  const pollPromise = (async () => {
                    while (!captured && !skipRequested) {
                      await new Promise(r => setTimeout(r, 1500));
                      try {
                        const newStatus = await tool.getStatus();
                        if (!newStatus.contents?.airconStat) continue;
                        const newBuffer = Buffer.from(newStatus.contents.airconStat, 'base64');

                        // Check bytes 0-49 for changes (except ignored bytes)
                        for (let i = 0; i < 50; i++) {
                          if (hIgnoreBytes.has(i)) continue;
                          if (newBuffer[i] !== hReference![i]) {
                            hSwingCaptures[pos] = newBuffer;
                            captured = true;
                            console.log(`  ✓ Detected ${pos}! byte${i} changed: 0x${hReference![i].toString(16).padStart(2, '0')} → 0x${newBuffer[i].toString(16).padStart(2, '0')}`);
                            hReference = newBuffer;
                            break;
                          }
                        }
                      } catch (e) { }
                    }
                  })();

                  await Promise.race([skipPromise, pollPromise]);

                  // Clean up listener if poll succeeded
                  if (lineHandler && captured) {
                    rl.removeListener('line', lineHandler);
                  }

                  if (skipRequested && !captured) console.log(`  Skipped ${pos}`);
                }

                const hPosNames = Object.keys(hSwingCaptures);
                if (hPosNames.length >= 2) {
                  console.log('\n=== HORIZONTAL SWING ANALYSIS ===');

                  // Find which bytes differ
                  const hDifferingBytes: number[] = [];
                  for (let i = 0; i < 25; i++) {
                    const values = new Set<number>();
                    for (const pos of hPosNames) {
                      values.add(hSwingCaptures[pos][i]);
                    }
                    if (values.size > 1) hDifferingBytes.push(i);
                  }

                  console.log(`Bytes that differ: ${hDifferingBytes.join(', ')}`);
                  for (const byteIdx of hDifferingBytes) {
                    console.log(`\nByte ${byteIdx}:`);
                    for (const pos of hPosNames) {
                      const val = hSwingCaptures[pos][byteIdx];
                      console.log(`  ${pos}: 0x${val.toString(16).padStart(2, '0')} = ${val} (bits 0-3: ${val & 0x0F})`);
                    }
                  }
                }
              }
            }

            // === VERTICAL SWING CALIBRATION ===
            const doVSwing = await new Promise<boolean>((resolve) => {
              rl.question('\nCalibrate vertical swing (up/down)? (y/n): ', (answer) => {
                resolve(answer.trim().toLowerCase() === 'y');
              });
            });

            const vSwingCaptures: Record<string, Buffer> = {};

            if (doVSwing) {
              console.log('\n=== VERTICAL SWING CALIBRATION ===');
              console.log('First, set vertical to SWING mode in the Smart M app.');
              console.log('Then we\'ll capture each position as you set them.\n');

              const vPositions = ['Swing', 'Highest', 'High', 'Middle', 'Low', 'Lowest'];

              let vStatus = await tool.getStatus();
              let vReference = vStatus.contents?.airconStat
                ? Buffer.from(vStatus.contents.airconStat, 'base64')
                : null;

              if (vReference) {
                await new Promise<void>((resolve) => {
                  rl.question('What vertical position is it currently at? (or Enter to skip): ', async (current) => {
                    if (current.trim()) {
                      vSwingCaptures[current.trim()] = Buffer.from(vReference!);
                      console.log(`  Captured as "${current.trim()}", byte6 = 0x${vReference![6].toString(16).padStart(2, '0')}`);
                    }
                    resolve();
                  });
                });

                // Bytes to ignore when detecting swing changes (mode, fan, temp, CRC)
                // Also ignore byte 11-12 which we found is horizontal swing
                const vIgnoreBytes = new Set([2, 3, 4, 11, 12, 23, 24]);

                for (const pos of vPositions) {
                  if (vSwingCaptures[pos]) {
                    console.log(`  ${pos} already captured, skipping...`);
                    continue;
                  }

                  console.log(`📱 Set vertical swing to ${pos}... (or 's' to skip)`);

                  let captured = false;
                  let skipRequested = false;
                  let lineHandler: ((input: string) => void) | null = null;

                  const skipPromise = new Promise<void>((resolve) => {
                    lineHandler = (input: string) => {
                      if (input.trim().toLowerCase() === 's') {
                        skipRequested = true;
                        resolve();
                      }
                    };
                    rl.once('line', lineHandler);
                  });

                  const pollPromise = (async () => {
                    while (!captured && !skipRequested) {
                      await new Promise(r => setTimeout(r, 1500));
                      try {
                        const newStatus = await tool.getStatus();
                        if (!newStatus.contents?.airconStat) continue;
                        const newBuffer = Buffer.from(newStatus.contents.airconStat, 'base64');

                        // Check bytes 0-49 for changes (except ignored bytes)
                        for (let i = 0; i < 50; i++) {
                          if (vIgnoreBytes.has(i)) continue;
                          if (newBuffer[i] !== vReference![i]) {
                            vSwingCaptures[pos] = newBuffer;
                            captured = true;
                            console.log(`  ✓ Detected ${pos}! byte${i} changed: 0x${vReference![i].toString(16).padStart(2, '0')} → 0x${newBuffer[i].toString(16).padStart(2, '0')}`);
                            vReference = newBuffer;
                            break;
                          }
                        }
                      } catch (e) { }
                    }
                  })();

                  await Promise.race([skipPromise, pollPromise]);

                  // Clean up listener if poll succeeded
                  if (lineHandler && captured) {
                    rl.removeListener('line', lineHandler);
                  }

                  if (skipRequested && !captured) console.log(`  Skipped ${pos}`);
                }

                const vPosNames = Object.keys(vSwingCaptures);
                if (vPosNames.length >= 2) {
                  console.log('\n=== VERTICAL SWING ANALYSIS ===');

                  // Find which bytes differ
                  const vDifferingBytes: number[] = [];
                  for (let i = 0; i < 25; i++) {
                    const values = new Set<number>();
                    for (const pos of vPosNames) {
                      values.add(vSwingCaptures[pos][i]);
                    }
                    if (values.size > 1) vDifferingBytes.push(i);
                  }

                  console.log(`Bytes that differ: ${vDifferingBytes.join(', ')}`);
                  for (const byteIdx of vDifferingBytes) {
                    console.log(`\nByte ${byteIdx}:`);
                    for (const pos of vPosNames) {
                      const val = vSwingCaptures[pos][byteIdx];
                      console.log(`  ${pos}: 0x${val.toString(16).padStart(2, '0')} = ${val} (bits 0-3: ${val & 0x0F})`);
                    }
                  }
                }
              }
            }

            console.log('\n=== CALIBRATION COMPLETE ===');
            console.log('Use the values above to update DEFAULT_CALIBRATION in src/calibration.ts');

          } else {
            console.log('Unknown command. Type a command or "q" to quit.');
          }
        } catch (error: any) {
          console.error('Error:', error.message);
        }

        prompt();
      });
    };

    prompt();

  } catch (error: any) {
    console.error('Error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('\nConnection refused. Make sure the device is online and port 51443 is accessible.');
    }
    process.exit(1);
  }
}

main();
