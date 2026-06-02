/**
 * MHI WF-RAC API Protocol Implementation
 *
 * Ported from the reference open-source implementations, which all share an
 * identical airconStat buffer codec:
 *   - hacki11/ioBroker.mhi-wfrac        (lib/AirconStatCoder.js)
 *   - jeatheak/Mitsubishi-WF-RAC-Integration (wfrac/rac_parser.py)
 *   - JobDoesburg/homebridge-mhi-wfrac  (src/device.ts)
 *
 * Two transports are supported, selected per-device:
 *   - Legacy firmware: plain HTTP, POST http://<ip>:51443/beaver/command
 *     with the command name in the JSON body.
 *   - WF-RAC-HTTPS firmware (wireless 025 / mcu 200+): TLS, POST
 *     https://<ip>:51443/beaver/command/<command> (command in the URL path),
 *     self-signed device certificate.
 * The status buffer encoding is the same for both.
 */

import axios, { AxiosError } from 'axios';
import * as https from 'https';
import { OUTDOOR_TEMP_LIST, INDOOR_TEMP_LIST } from './temp-tables';

export { OUTDOOR_TEMP_LIST, INDOOR_TEMP_LIST };

// Operation modes (string enum kept for the device-class public API)
export enum OperationMode {
  Auto = 'auto',
  Cool = 'cool',
  Heat = 'heat',
  Fan = 'fan',
  Dry = 'dry',
}

// Airflow levels
export enum AirflowLevel {
  Auto = 'auto',
  Lowest = 'lowest',
  Low = 'low',
  High = 'high',
  Highest = 'highest',
}

// The protocol encodes mode/airflow as a 0-4 index. These arrays map that
// index to/from our string enums (index order matches the reference).
const MODE_BY_INDEX = [OperationMode.Auto, OperationMode.Cool, OperationMode.Heat, OperationMode.Fan, OperationMode.Dry];
const AIRFLOW_BY_INDEX = [AirflowLevel.Auto, AirflowLevel.Lowest, AirflowLevel.Low, AirflowLevel.High, AirflowLevel.Highest];

function modeToIndex(mode: OperationMode): number {
  const i = MODE_BY_INDEX.indexOf(mode);
  return i < 0 ? 0 : i;
}
function airflowToIndex(airflow: AirflowLevel): number {
  const i = AIRFLOW_BY_INDEX.indexOf(airflow);
  return i < 0 ? 0 : i;
}

/**
 * Find the index of `value` in `posVals`, plus `p`; -1 if not found.
 * Mirrors the reference findMatch().
 */
function findMatch(value: number, posVals: number[], p = 0): number {
  const i = posVals.indexOf(value);
  return i < 0 ? -1 : i + p;
}

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final xor).
 * Exported for tests.
 */
export function crc16ccitt(data: number[]): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= (byte & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Device status representing the current state of the AC unit.
 *
 * Decode reads the dynamically-located status block; encode rebuilds a fresh
 * command buffer from these fields (preserving everything we decoded, so that
 * changing one setting does not disturb the others).
 */
export class DeviceStatus {
  // Power state
  operation = false;
  // Operating mode
  operationMode: OperationMode = OperationMode.Auto;
  // Target temperature (0.5 deg increments)
  presetTemp = 25;
  // Current indoor / outdoor temperature (from lookup tables; may be undefined)
  indoorTemp?: number;
  outdoorTemp?: number;
  // Airflow level
  airflow: AirflowLevel = AirflowLevel.Auto;
  // Vane positions (0-based protocol indices; preserved across round-trips)
  windDirectionUD = 0;
  windDirectionLR = 0;
  // Misc flags carried through round-trips
  entrust = false;
  coolHotJudge = true;
  modelNo = 0;
  isVacantProperty = false;
  isSelfCleanReset = false;
  isSelfCleanOperation = false;
  // Telemetry
  electric = 0;
  errorCode = '00';

  /**
   * Decode device status from the base64 airconStat string.
   * The status block starts at a dynamic offset (byte[18] * 4 + 21); every
   * field below is relative to that offset (data[N] = buffer[dataStart + N]).
   */
  static fromBase64(base64: string): DeviceStatus {
    const status = new DeviceStatus();
    const buf = Buffer.from(base64, 'base64');
    const arr: number[] = Array.from(buf); // unsigned bytes 0-255

    const dataStart = arr[18] * 4 + 21;
    const data = arr.slice(dataStart, arr.length - 2);

    status.operation = (data[2] & 0x03) === 1;
    status.presetTemp = data[4] / 2;
    status.operationMode = MODE_BY_INDEX[findMatch(60 & data[2], [0, 8, 16, 12, 4])] ?? OperationMode.Auto;
    status.airflow = AIRFLOW_BY_INDEX[findMatch(15 & data[3], [7, 0, 1, 2, 6])] ?? AirflowLevel.Auto;
    status.windDirectionUD = (data[2] & 192) === 64 ? 0 : findMatch(240 & data[3], [0, 16, 32, 48], 1);
    status.windDirectionLR = (data[12] & 3) === 1 ? 0 : findMatch(31 & data[11], [0, 1, 2, 3, 4, 5, 6], 1);
    status.entrust = (12 & data[12]) === 4;
    status.coolHotJudge = (data[8] & 8) <= 0;
    status.modelNo = findMatch(data[0] & 127, [0, 1, 2]);
    status.isVacantProperty = (data[10] & 1) !== 0;

    const code = data[6] & 127;
    if (code === 0) status.errorCode = '00';
    else if ((data[6] & 128) === 0) status.errorCode = `M${String(code).padStart(2, '0')}`;
    else status.errorCode = `E${code}`;

    // Temperature / electric TLV region: 4-byte records after the status block.
    status.electric = 0;
    for (let i = dataStart + 19; i + 3 < arr.length - 1; i += 4) {
      const m0 = arr[i], m1 = arr[i + 1], v = arr[i + 2] & 0xff;
      if (m0 === 0x80 && m1 === 0x10) status.outdoorTemp = OUTDOOR_TEMP_LIST[v];
      else if (m0 === 0x80 && m1 === 0x20) status.indoorTemp = INDOOR_TEMP_LIST[v];
      else if (m0 === 0x94 && m1 === 0x10) status.electric = (arr[i + 2] | (arr[i + 3] << 8)) * 0.25;
    }

    return status;
  }

  /**
   * Build the 18-byte "command" segment (the values the unit acts on; temp
   * carries the +128 command marker).
   */
  private commandSegment(): number[] {
    const b = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const mode = modeToIndex(this.operationMode);
    const air = airflowToIndex(this.airflow);

    b[2] |= this.operation ? 3 : 2;

    switch (mode) {
      case 0: b[2] |= 32; break;
      case 1: b[2] |= 40; break;
      case 2: b[2] |= 48; break;
      case 3: b[2] |= 44; break;
      case 4: b[2] |= 36; break;
    }
    switch (air) {
      case 0: b[3] |= 15; break;
      case 1: b[3] |= 8; break;
      case 2: b[3] |= 9; break;
      case 3: b[3] |= 10; break;
      case 4: b[3] |= 14; break;
    }
    switch (this.windDirectionUD) {
      case 0: b[2] |= 192; b[3] |= 128; break;
      case 1: b[2] |= 128; b[3] |= 128; break;
      case 2: b[2] |= 128; b[3] |= 144; break;
      case 3: b[2] |= 128; b[3] |= 160; break;
      case 4: b[2] |= 128; b[3] |= 176; break;
    }
    switch (this.windDirectionLR) {
      case 0: b[12] |= 3; b[11] |= 16; break;
      case 1: b[12] |= 2; b[11] |= 16; break;
      case 2: b[12] |= 2; b[11] |= 17; break;
      case 3: b[12] |= 2; b[11] |= 18; break;
      case 4: b[12] |= 2; b[11] |= 19; break;
      case 5: b[12] |= 2; b[11] |= 20; break;
      case 6: b[12] |= 2; b[11] |= 21; break;
      case 7: b[12] |= 2; b[11] |= 22; break;
    }

    const presetTemp = mode === 3 ? 25.0 : this.presetTemp;
    b[4] |= Math.floor(presetTemp / 0.5) + 128;

    b[12] |= this.entrust ? 12 : 8;

    if (this.modelNo === 1) {
      b[10] |= this.isVacantProperty ? 1 : 0;
    }
    if (this.modelNo === 1 || this.modelNo === 2) {
      b[10] |= this.isSelfCleanReset ? 4 : 0;
      b[10] |= this.isSelfCleanOperation ? 144 : 128;
    }
    return b;
  }

  /**
   * Build the 18-byte "receive" segment (the expected resulting state; temp
   * without the +128 marker).
   */
  private receiveSegment(): number[] {
    const b = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const mode = modeToIndex(this.operationMode);
    const air = airflowToIndex(this.airflow);

    if (this.operation) b[2] |= 1;

    switch (mode) {
      case 1: b[2] |= 8; break;
      case 2: b[2] |= 16; break;
      case 3: b[2] |= 12; break;
      case 4: b[2] |= 4; break;
    }
    switch (air) {
      case 0: b[3] |= 7; break;
      case 2: b[3] |= 1; break;
      case 3: b[3] |= 2; break;
      case 4: b[3] |= 6; break;
    }
    switch (this.windDirectionUD) {
      case 0: b[2] |= 64; break;
      case 2: b[3] |= 16; break;
      case 3: b[3] |= 32; break;
      case 4: b[3] |= 48; break;
    }
    switch (this.windDirectionLR) {
      case 0: b[12] |= 1; break;
      case 2: b[11] |= 1; break;
      case 3: b[11] |= 2; break;
      case 4: b[11] |= 3; break;
      case 5: b[11] |= 4; break;
      case 6: b[11] |= 5; break;
      case 7: b[11] |= 6; break;
    }

    const presetTemp = mode === 3 ? 25.0 : this.presetTemp;
    b[4] |= Math.floor(presetTemp / 0.5);

    if (this.entrust) b[12] |= 4;
    if (!this.coolHotJudge) b[8] |= 8;
    if (this.modelNo === 1) b[0] |= 1;
    else if (this.modelNo === 2) b[0] |= 2;
    if (this.modelNo === 1) b[10] |= this.isVacantProperty ? 1 : 0;
    if (this.modelNo === 1 || this.modelNo === 2) {
      if (this.isSelfCleanOperation) b[15] |= 1;
    }
    return b;
  }

  /** Encode to the base64 airconStat string for a setAirconStat command. */
  toBase64(): string {
    const withVariableAndCrc = (segment: number[]): number[] => {
      const buf = segment.concat([1, 255, 255, 255, 255]);
      const crc = crc16ccitt(buf);
      return buf.concat([crc & 0xff, (crc >> 8) & 0xff]);
    };
    const out = withVariableAndCrc(this.commandSegment()).concat(withVariableAndCrc(this.receiveSegment()));
    return Buffer.from(out).toString('base64');
  }

  /** Clone this status (value copy of all fields). */
  clone(): DeviceStatus {
    return Object.assign(new DeviceStatus(), this);
  }
}

/**
 * API response shape (subset we use).
 */
export interface AirconStatResponse {
  result: number;
  contents?: {
    airconStat?: string;
    airconId?: string;
    firmType?: string;
    wireless?: { firmVer?: string };
    mcu?: { firmVer?: string };
    remoteList?: string[];
  };
}

interface DeviceInfoResponse {
  result: number;
  contents?: { airconId?: string; macAddress?: string };
}

export interface DiscoveredDevice {
  ip: string;
  mac: string;
}

const CONNECTION_ERRORS = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EPROTO', 'EPIPE'];

function isConnectionError(error: unknown): boolean {
  return error instanceof AxiosError && !!error.code && CONNECTION_ERRORS.includes(error.code);
}

// Self-signed device certificate: there is no CA to trust (the unit generates
// its own cert with its MAC as the CN), so verification is skipped. This is the
// standard approach used by every MHI WF-RAC integration. A future improvement
// is to pin the device's certificate fingerprint.
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

type Protocol = 'http' | 'https';

interface CommandReply {
  data: any;
  protocol: Protocol;
}

/**
 * POST a command to a device, trying the given protocol(s). Newer firmware
 * needs HTTPS with the command in the path; legacy firmware uses HTTP with the
 * command in the body. Returns the reply and which protocol worked, or null on
 * a connection failure for every attempted protocol.
 */
async function postCommand(
  ip: string,
  port: number,
  command: string,
  body: Record<string, unknown>,
  opts: { protocol?: Protocol; timeout?: number } = {},
): Promise<CommandReply | null> {
  const timeout = opts.timeout ?? 10000;
  const order: Protocol[] = opts.protocol ? [opts.protocol] : ['https', 'http'];

  let lastConnError: unknown;
  for (const protocol of order) {
    const url = protocol === 'https'
      ? `https://${ip}:${port}/beaver/command/${command}`
      : `http://${ip}:${port}/beaver/command`;
    try {
      const res = await axios.post(url, body, {
        timeout,
        // The device handles one request at a time and can hang if the socket
        // is reused; force a fresh, closed connection per request.
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        httpsAgent: protocol === 'https' ? httpsAgent : undefined,
      });
      return { data: res.data, protocol };
    } catch (error) {
      if (isConnectionError(error)) {
        lastConnError = error;
        continue; // try the next protocol
      }
      throw error;
    }
  }
  void lastConnError;
  return null;
}

/** Generate a UUID v4 (uppercase), used as the operator id. */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16).toUpperCase();
  });
}

/** Probe an IP for an MHI device (tries HTTPS then HTTP). */
export async function probeDevice(ip: string, port = 51443): Promise<DiscoveredDevice | null> {
  try {
    const reply = await postCommand(ip, port, 'getDeviceInfo', {
      apiVer: '1.0',
      command: 'getDeviceInfo',
      deviceId: 'discovery',
      operatorId: 'discovery',
      timestamp: Math.floor(Date.now() / 1000),
    }, { timeout: 3000 });

    const info = reply?.data as DeviceInfoResponse | undefined;
    if (info?.result === 0 && info.contents?.airconId) {
      return { ip, mac: info.contents.airconId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Scan a subnet for MHI devices. */
export async function discoverDevices(
  subnet: string,
  startIp = 1,
  endIp = 254,
  concurrency = 20,
): Promise<DiscoveredDevice[]> {
  const devices: DiscoveredDevice[] = [];
  const ips: string[] = [];
  for (let i = startIp; i <= endIp; i++) ips.push(`${subnet}.${i}`);

  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((ip) => probeDevice(ip)));
    for (const r of results) if (r) devices.push(r);
  }
  return devices;
}

/** Register an operator id with the AC unit. */
export async function registerOperator(
  ip: string,
  airconId: string,
  operatorId: string,
  operatorName = 'Scrypted',
  port = 51443,
): Promise<boolean> {
  try {
    const reply = await postCommand(ip, port, 'updateAccountInfo', {
      apiVer: '1.0',
      command: 'updateAccountInfo',
      deviceId: airconId,
      operatorId,
      timestamp: Math.floor(Date.now() / 1000),
      contents: { accountId: operatorId, operatorId, airconId, accountName: operatorName },
    });
    return (reply?.data as AirconStatResponse | undefined)?.result === 0;
  } catch {
    return false;
  }
}

/**
 * API client for a single AC unit. Remembers which transport worked so it does
 * not re-probe both protocols on every call.
 */
export class DeviceClient {
  private readonly ip: string;
  private readonly port: number;
  private readonly operatorId: string;
  private readonly deviceId: string;
  private protocol?: Protocol;

  constructor(ip: string, deviceId: string, operatorId: string, port = 51443) {
    this.ip = ip;
    this.port = port;
    this.operatorId = operatorId;
    this.deviceId = deviceId;
  }

  /** Which transport this client last used successfully ('http' | 'https' | undefined). */
  get transport(): Protocol | undefined {
    return this.protocol;
  }

  private async command(command: string, contents?: Record<string, unknown>): Promise<any | null> {
    const body: Record<string, unknown> = {
      apiVer: '1.0',
      command,
      deviceId: this.deviceId,
      operatorId: this.operatorId,
      timestamp: Math.floor(Date.now() / 1000),
    };
    if (contents) body.contents = contents;

    const reply = await postCommand(this.ip, this.port, command, body, { protocol: this.protocol });
    if (reply) {
      this.protocol = reply.protocol;
      return reply.data;
    }
    return null;
  }

  // result 0 = ok, 1 = ok (cached), 12 = ok (busy/rate-limited)
  private static okResult(result: number | undefined): boolean {
    return result === 0 || result === 1 || result === 12;
  }

  /** Fetch and decode the current device status, or null if unreachable. */
  async getDeviceStatus(): Promise<DeviceStatus | null> {
    try {
      const data = await this.command('getAirconStat') as AirconStatResponse | null;
      if (!data) return null;
      if (!DeviceClient.okResult(data.result)) {
        throw new Error(`getAirconStat returned result ${data.result}`);
      }
      const airconStat = data.contents?.airconStat;
      if (!airconStat) return null;
      return DeviceStatus.fromBase64(airconStat);
    } catch (error) {
      if (isConnectionError(error)) return null;
      throw error;
    }
  }

  /** Send a full status as a setAirconStat command. */
  async setDeviceStatus(status: DeviceStatus): Promise<boolean> {
    try {
      const data = await this.command('setAirconStat', {
        airconId: this.deviceId,
        airconStat: status.toBase64(),
      }) as AirconStatResponse | null;
      return DeviceClient.okResult(data?.result);
    } catch (error) {
      if (isConnectionError(error)) return false;
      throw error;
    }
  }

  /** Read-modify-write helper: fetch status, mutate, send. */
  private async update(mutate: (s: DeviceStatus) => void): Promise<boolean> {
    const status = await this.getDeviceStatus();
    if (!status) return false;
    mutate(status);
    return this.setDeviceStatus(status);
  }

  setOperation(on: boolean): Promise<boolean> {
    return this.update((s) => { s.operation = on; });
  }

  setOperationMode(mode: OperationMode): Promise<boolean> {
    return this.update((s) => { s.operationMode = mode; });
  }

  setPresetTemp(temp: number): Promise<boolean> {
    const clamped = Math.round(Math.max(18, Math.min(30, temp)) * 2) / 2;
    return this.update((s) => { s.presetTemp = clamped; });
  }

  setAirflow(airflow: AirflowLevel): Promise<boolean> {
    return this.update((s) => { s.airflow = airflow; });
  }
}
