#!/usr/bin/env npx tsx
/**
 * MHI WF-RAC debug tool
 *
 * A small standalone REPL for poking a unit directly, using the plugin's own
 * protocol code (src/api.ts). It auto-detects the transport, so it works for
 * both legacy HTTP and newer WF-RAC-HTTPS units.
 *
 *   npm run debug -- <ip> [mac]
 *   npx tsx debug-tool.ts <ip> [mac]
 *
 * The MAC is discovered automatically if omitted. An operator is registered so
 * that write commands are accepted.
 */

import * as readline from 'readline';
import {
  DeviceClient,
  OperationMode,
  AirflowLevel,
  probeDevice,
  registerOperator,
  generateUUID,
} from './src/api';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODES: Record<string, OperationMode> = {
  cool: OperationMode.Cool,
  heat: OperationMode.Heat,
  auto: OperationMode.Auto,
  fan: OperationMode.Fan,
  dry: OperationMode.Dry,
};
const AIRFLOWS: Record<string, AirflowLevel> = {
  auto: AirflowLevel.Auto,
  lowest: AirflowLevel.Lowest,
  low: AirflowLevel.Low,
  high: AirflowLevel.High,
  highest: AirflowLevel.Highest,
};

async function main() {
  const ip = process.argv[2];
  let mac = process.argv[3];
  if (!ip) {
    console.log('Usage: npx tsx debug-tool.ts <ip> [mac]');
    process.exit(1);
  }

  console.log(`Probing ${ip}...`);
  if (!mac) {
    const found = await probeDevice(ip);
    if (!found) {
      console.log(`No MHI device found at ${ip}`);
      process.exit(1);
    }
    mac = found.mac;
  }
  console.log('MAC:', mac);

  const operatorId = generateUUID();
  console.log('Registering operator...');
  console.log('  registered:', await registerOperator(ip, mac, operatorId, 'Scrypted'));

  const client = new DeviceClient(ip, mac, operatorId);

  const showStatus = async () => {
    const s = await client.getDeviceStatus();
    if (!s) {
      console.log('  (no response)');
      return;
    }
    console.log(`  transport=${client.transport} power=${s.operation ? 'ON' : 'OFF'} ` +
      `mode=${s.operationMode} setpoint=${s.presetTemp}C fan=${s.airflow} ` +
      `indoor=${s.indoorTemp}C outdoor=${s.outdoorTemp}C`);
  };

  console.log('\nInitial status:');
  await showStatus();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const help = () => {
    console.log('\nCommands:');
    console.log('  r                              read status');
    console.log('  on | off                       power');
    console.log('  cool | heat | auto | fan | dry set mode');
    console.log('  t <NN>                         set setpoint (18-30)');
    console.log('  fan <auto|lowest|low|high|highest>');
    console.log('  q                              quit');
  };

  const run = async (input: string): Promise<void> => {
    const [cmd, arg] = input.trim().toLowerCase().split(/\s+/);
    if (cmd === 'q' || cmd === 'quit') {
      rl.close();
      process.exit(0);
    } else if (cmd === '' || cmd === 'r') {
      await showStatus();
      return;
    } else if (cmd === 'on') {
      console.log('  ->', await client.setOperation(true));
    } else if (cmd === 'off') {
      console.log('  ->', await client.setOperation(false));
    } else if (MODES[cmd]) {
      console.log('  ->', await client.setOperationMode(MODES[cmd]));
    } else if (cmd === 't' && arg) {
      console.log('  ->', await client.setPresetTemp(parseFloat(arg)));
    } else if (cmd === 'fan' && AIRFLOWS[arg]) {
      console.log('  ->', await client.setAirflow(AIRFLOWS[arg]));
    } else {
      console.log('  unknown command');
      return;
    }
    // The unit handles one request at a time; give it a moment before reading back.
    await wait(1200);
    await showStatus();
  };

  help();
  const prompt = () => rl.question('\n> ', async (input) => {
    try {
      await run(input);
    } catch (e: any) {
      console.error('  error:', e?.message ?? e);
    }
    prompt();
  });
  prompt();
}

main();
