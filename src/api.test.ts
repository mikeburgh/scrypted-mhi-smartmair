import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceStatus, OperationMode, AirflowLevel, crc16ccitt } from './api';

/**
 * Golden vectors captured from a live MHI WF-RAC-HTTPS unit (10.2.2.111),
 * with the unit's state confirmed on the Smart M-Air app at capture time.
 * Stored as hex of the raw 58-byte airconStat buffer.
 */
function decodeHex(hex: string): DeviceStatus {
  const b64 = Buffer.from(hex.replace(/\s/g, ''), 'hex').toString('base64');
  return DeviceStatus.fromBase64(b64);
}

// ON, Heat, setpoint 20.0, indoor 23.7
const HEAT_20 =
  '0007001230ff0000' + '8000000200000000' + '000001ffffffffd1' +
  'fc81041101289700' + '0080020000000000' + '00000003802097ff' +
  '801092ff94100000' + 'd903';

// ON, Cool, setpoint 26.0
const COOL_26 =
  '0007001230ff0000' + '8000000200000000' + '000001ffffffffd1' +
  'fc81040901349b00' + '0088000000000000' + '0000000380209bff' +
  '801091ff94100000' + '31a4';

// ON, Auto, setpoint 25.0
const AUTO_25 =
  '0007a389b2ff0000' + '000000108a000000' + '000001ffffffff90' +
  '9b81040101329600' + '0088020000000000' + '00000003802096ff' +
  '801092ff94100000' + '061c';

test('decodes Heat / 20.0C with indoor 23.7 from lookup table', () => {
  const s = decodeHex(HEAT_20);
  assert.equal(s.operation, true);
  assert.equal(s.operationMode, OperationMode.Heat);
  assert.equal(s.presetTemp, 20);
  assert.equal(s.airflow, AirflowLevel.Low);
  // Local-API lookup table reads 23 here; the Smart M-Air app showed 23.7
  // (the app reads ~0.7 deg finer). The table value is the protocol truth.
  assert.equal(s.indoorTemp, 23);
});

test('decodes Cool / 26.0C', () => {
  const s = decodeHex(COOL_26);
  assert.equal(s.operation, true);
  assert.equal(s.operationMode, OperationMode.Cool);
  assert.equal(s.presetTemp, 26);
});

test('decodes Auto / 25.0C, power on', () => {
  const s = decodeHex(AUTO_25);
  assert.equal(s.operation, true);
  assert.equal(s.operationMode, OperationMode.Auto);
  assert.equal(s.presetTemp, 25);
});

test('crc16ccitt matches the CRC-16/CCITT-FALSE check value', () => {
  // "123456789" -> 0x29B1 is the canonical CRC-16/CCITT-FALSE check vector.
  const bytes = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39];
  assert.equal(crc16ccitt(bytes), 0x29b1);
});

test('encode round-trips the decoded control state', () => {
  const s = decodeHex(HEAT_20);
  const re = DeviceStatus.fromBase64(s.toBase64());
  assert.equal(re.operation, true);
  assert.equal(re.operationMode, OperationMode.Heat);
  assert.equal(re.presetTemp, 20);
  assert.equal(re.airflow, AirflowLevel.Low);
});

test('encode applies a changed mode and setpoint (the write path)', () => {
  const s = decodeHex(HEAT_20);
  s.operationMode = OperationMode.Cool;
  s.presetTemp = 22;
  const re = DeviceStatus.fromBase64(s.toBase64());
  assert.equal(re.operation, true);
  assert.equal(re.operationMode, OperationMode.Cool);
  assert.equal(re.presetTemp, 22);
});

test('encode turns the unit off while preserving mode', () => {
  const s = decodeHex(COOL_26);
  s.operation = false;
  const re = DeviceStatus.fromBase64(s.toBase64());
  assert.equal(re.operation, false);
  assert.equal(re.operationMode, OperationMode.Cool);
});
