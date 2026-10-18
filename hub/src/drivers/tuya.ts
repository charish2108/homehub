/**
 * Tuya local LAN driver — protocol 3.1 / 3.3, faithful port of tinytuya
 * (https://github.com/jasonacox/tinytuya, MIT). No cloud needed once you have
 * the device's `localKey`.
 *
 * Getting the localKey: run `pip install tinytuya` then `tinytuya wizard`
 * (uses your Tuya IoT Platform project creds), or use the "Device Debug"
 * screen in the Smart Life app via a rooted approach. See README.
 *
 * Config options:
 *   deviceId  (required)  - Tuya device id ("uuid" in discovery output)
 *   localKey  (required)  - 16-char local key
 *   version   ("3.3")     - protocol version
 *   dps       {power:"1", temperature:"2", mode:"3", fan:"4", ...} - DP map
 *   modeValues {cool:"cold", heat:"hot", dry:"wet", fan:"fan", auto:"auto"}
 *
 * EXPERIMENTAL: correct per the protocol, but not verified against hardware
 * in this environment. If a device misbehaves, try version "3.1".
 */
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { assertPrivateHost } from '../util';

// ---- wire protocol ------------------------------------------------------

const PREFIX_55AA = 0x000055aa;
const SUFFIX_55AA = 0x0000aa55;
const CONTROL = 0x07;
const HEART_BEAT = 0x09;
const DP_QUERY = 0x0a;
const CONTROL_NEW = 0x0d;
const PROTOCOL_3x_HEADER = Buffer.alloc(12, 0);
const UDP_PORT = 6666;
const UDP_PORT_S = 6667;
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function aesEcb(key: Buffer, data: Buffer, encryptMode: boolean): Buffer {
  const cipher = encryptMode
    ? crypto.createCipheriv('aes-128-ecb', key, null)
    : crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function pkcs7Pad(data: Buffer): Buffer {
  const pad = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function packMessage(seqno: number, cmd: number, payload: Buffer): Buffer {
  const msgLen = payload.length + 8; // crc(4) + suffix(4)
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX_55AA, 0);
  header.writeUInt32BE(seqno, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(msgLen, 12);
  const body = Buffer.concat([header, payload]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(crc32(body), 0);
  tail.writeUInt32BE(SUFFIX_55AA, 4);
  return Buffer.concat([body, tail]);
}

interface ParsedMessage {
  seqno: number;
  cmd: number;
  retcode: number;
  payload: Buffer;
}

function parseMessage(buf: Buffer): ParsedMessage {
  if (buf.length < 16) throw new Error('Tuya frame too short');
  const prefix = buf.readUInt32BE(0);
  if (prefix !== PREFIX_55AA) throw new Error(`Unexpected Tuya prefix ${prefix.toString(16)}`);
  const seqno = buf.readUInt32BE(4);
  const cmd = buf.readUInt32BE(8);
  const msgLen = buf.readUInt32BE(12);
  if (buf.length < 16 + msgLen) throw new Error('Truncated Tuya frame');
  const retcode = buf.readUInt32BE(16);
  const payload = buf.subarray(20, 16 + msgLen - 8);
  return { seqno, cmd, retcode, payload };
}

// ---- driver -------------------------------------------------------------

export class TuyaDriver implements DeviceDriver {
  readonly label = 'Tuya (local)';
  readonly actions: ActionDef[] = [
    { name: 'toggle_power', label: 'Power on/off' },
    { name: 'power_on', label: 'Power on' },
    { name: 'power_off', label: 'Power off' },
    { name: 'temperature_set', label: 'Set temperature', params: [{ name: 'value', type: 'number', min: 16, max: 30 }] },
    { name: 'temperature_up', label: 'Temperature up' },
    { name: 'temperature_down', label: 'Temperature down' },
    { name: 'mode_set', label: 'Set mode', params: [{ name: 'value', type: 'enum', options: ['cool', 'heat', 'dry', 'fan', 'auto'] }] },
    { name: 'fan_set', label: 'Fan speed', params: [{ name: 'value', type: 'enum', options: ['auto', 'low', 'medium', 'high'] }] },
    { name: 'brightness_set', label: 'Brightness', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] },
    { name: 'set_dp', label: 'Set raw DP', params: [{ name: 'dp', type: 'string' }, { name: 'value', type: 'string' }] },
  ];

  private seqno = 1;
  private state: DeviceState = {};
  private dps: Record<string, any> = {};

  private readonly devId: string;
  private readonly localKey: Buffer;
  private readonly version: string;
  private readonly dpsMap: Record<string, string>;
  private readonly modeValues: Record<string, any>;
  private readonly fanValues: Record<string, any>;

  constructor(
    private host: string,
    opts: Record<string, any>,
  ) {
    this.devId = String(opts.deviceId ?? '');
    if (!this.devId) throw new Error('tuya driver requires options.deviceId');
    const key = String(opts.localKey ?? '');
    if (key.length !== 16) throw new Error('tuya driver requires options.localKey (16 chars)');
    this.localKey = Buffer.from(key, 'utf8');
    this.version = String(opts.version ?? '3.3');
    this.dpsMap = { power: '1', temperature: '2', mode: '3', fan: '4', brightness: '3', ...(opts.dps ?? {}) };
    this.modeValues = { cool: 'cold', heat: 'hot', dry: 'wet', fan: 'fan', auto: 'auto', ...(opts.modeValues ?? {}) };
    this.fanValues = { auto: 'auto', low: 'low', medium: 'medium', high: 'high', ...(opts.fanValues ?? {}) };
  }

  async start(): Promise<void> {
    /* connection is per-request; poll() establishes reachability */
  }

  async stop(): Promise<void> {
    /* nothing persistent */
  }

  async poll(): Promise<DeviceState | null> {
    try {
      const json = await this.sendReceive(DP_QUERY, {});
      if (!json || typeof json !== 'object') return null;
      this.dps = (json as any).dps ?? this.dps;
      this.state = this.mapDps(this.dps);
      return { ...this.state };
    } catch {
      return null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    const set = (dp: string, value: any) => this.sendReceive(CONTROL, { [dp]: value });
    const powerDp = this.dpsMap.power;
    switch (name) {
      case 'power_on':
        await set(powerDp, true);
        this.state.power = true;
        return;
      case 'power_off':
        await set(powerDp, false);
        this.state.power = false;
        return;
      case 'toggle_power':
        await set(powerDp, !this.state.power);
        this.state.power = !this.state.power;
        return;
      case 'temperature_set': {
        const dp = this.dpsMap.temperature;
        if (!dp) throw new Error('No temperature DP configured for this device');
        await set(dp, Number(params.value));
        this.state.targetTemperature = Number(params.value);
        return;
      }
      case 'temperature_up':
        await this.action('temperature_set', { value: (this.state.targetTemperature ?? 24) + 1 });
        return;
      case 'temperature_down':
        await this.action('temperature_set', { value: (this.state.targetTemperature ?? 24) - 1 });
        return;
      case 'mode_set': {
        const dp = this.dpsMap.mode;
        if (!dp) throw new Error('No mode DP configured for this device');
        const mode = String(params.value);
        await set(dp, this.modeValues[mode] ?? mode);
        this.state.mode = mode;
        return;
      }
      case 'fan_set': {
        const dp = this.dpsMap.fan;
        if (!dp) throw new Error('No fan DP configured for this device');
        const fan = String(params.value);
        await set(dp, this.fanValues[fan] ?? fan);
        this.state.fan = fan;
        return;
      }
      case 'brightness_set': {
        const dp = this.dpsMap.brightness;
        if (!dp) throw new Error('No brightness DP configured for this device');
        await set(dp, Number(params.value));
        this.state.brightness = Number(params.value);
        return;
      }
      case 'set_dp':
        await set(String(params.dp), parseLoose(params.value));
        return;
      default:
        throw new Error(`Tuya device does not support "${name}"`);
    }
  }

  private mapDps(dps: Record<string, any>): DeviceState {
    const state: DeviceState = {};
    const get = (key: string) => dps[this.dpsMap[key]];
    if (get('power') !== undefined) state.power = !!get('power');
    if (get('temperature') !== undefined) state.targetTemperature = Number(get('temperature'));
    if (get('mode') !== undefined) state.mode = reverseLookup(this.modeValues, get('mode'));
    if (get('fan') !== undefined) state.fan = reverseLookup(this.fanValues, get('fan'));
    if (get('brightness') !== undefined) state.brightness = Number(get('brightness'));
    // Unknown DPs pass through for debugging in the app.
    state.dps = dps;
    return state;
  }

  // ---- socket session ---------------------------------------------------

  private encode(cmd: number, jsonObj: Record<string, any>): Buffer {
    const json = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    let payload: Buffer;
    if (this.version === '3.1') {
      if (cmd !== CONTROL) {
        payload = json;
      } else {
        const enc = aesEcb(this.localKey, pkcs7Pad(json), true).toString('base64');
        const md5 = crypto
          .createHash('md5')
          .update(Buffer.concat([Buffer.from(`data=${enc}||lpv=3.1||`), this.localKey]))
          .digest('hex');
        payload = Buffer.concat([Buffer.from('3.1'), Buffer.from(md5.slice(8, 24), 'utf8'), Buffer.from(enc, 'utf8')]);
      }
    } else {
      // 3.3: encrypt json, prepend version header except for query/heartbeat.
      const enc = aesEcb(this.localKey, pkcs7Pad(json), true);
      payload = cmd === DP_QUERY || cmd === HEART_BEAT ? enc : Buffer.concat([Buffer.from('3.3'), PROTOCOL_3x_HEADER, enc]);
    }
    return packMessage(this.seqno++, cmd, payload);
  }

  private decode(payload: Buffer): Record<string, any> | null {
    let text: string;
    if (this.version === '3.1') {
      if (payload.subarray(0, 3).toString() === '3.1') {
        text = aesEcb(this.localKey, payload.subarray(19), false).toString('utf8'); // 3 + 16 md5 bytes
      } else {
        text = payload.toString('utf8');
      }
    } else {
      const body = payload.subarray(0, 3).toString() === '3.3' ? payload.subarray(15) : payload;
      try {
        text = aesEcb(this.localKey, body, false).toString('utf8');
      } catch {
        return null;
      }
    }
    try {
      const json = JSON.parse(text.replace(/\0+$/, ''));
      if (json.data && json.data.dps && !json.dps) json.dps = json.data.dps;
      return json;
    } catch {
      return null;
    }
  }

  private async sendReceive(cmd: number, body: Record<string, any>): Promise<Record<string, any> | null> {
    await assertPrivateHost(this.host);
    const packet = this.encode(cmd, cmd === CONTROL ? { devId: this.devId, uid: '', t: Math.floor(Date.now() / 1000), dps: body } : body);
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: 6668 });
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('Tuya device timeout'))), 5000);
      socket.on('connect', () => socket.write(packet));
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          const msg = parseMessage(buffer);
          finish(() => resolve(this.decode(msg.payload)));
        } catch {
          /* keep buffering until the frame is complete */
        }
      });
      socket.on('error', (err) => finish(() => reject(err)));
      socket.on('close', () => finish(() => reject(new Error('Tuya connection closed'))));
    });
  }
}

function reverseLookup(map: Record<string, any>, value: any): string {
  for (const [k, v] of Object.entries(map)) if (v === value) return k;
  return String(value);
}

function parseLoose(value: unknown): any {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

// ---- discovery ----------------------------------------------------------

/** Passive scan for Tuya broadcasts on UDP 6666/6667 (~3.5s). */
export async function scanTuya(timeoutMs = 3500): Promise<Array<{ ip: string; id: string; version: string }>> {
  const dgram = await import('node:dgram');
  const found = new Map<string, { ip: string; id: string; version: string }>();
  const sockets = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
  await Promise.all(
    sockets.map(
      (s, i) =>
        new Promise<void>((resolve) => {
          s.on('error', () => resolve());
          s.on('message', (msg) => {
            try {
              const json = decodeUdp(msg, i === 1);
              if (json?.gwId) {
                found.set(json.gwId, { ip: json.ip ?? '', id: json.gwId, version: json.version ?? '3.3' });
              }
            } catch {
              /* not a tuya packet */
            }
          });
          s.bind(i === 0 ? UDP_PORT : UDP_PORT_S, () => resolve());
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  return [...found.values()];
}

function decodeUdp(msg: Buffer, encryptedPort: boolean): any {
  // 55AA framed packets carry a JSON or encrypted payload; raw ones are ECB with the UDP key.
  if (msg.length > 16 && msg.readUInt32BE(0) === PREFIX_55AA) {
    const parsed = parseMessage(msg);
    let payload = parsed.payload;
    if (payload.subarray(0, 3).toString() === '3.3') payload = payload.subarray(15);
    try {
      return JSON.parse(payload.toString('utf8'));
    } catch {
      try {
        return JSON.parse(aesEcb(UDP_KEY, payload, false).toString('utf8'));
      } catch {
        return null;
      }
    }
  }
  if (encryptedPort) {
    try {
      return JSON.parse(aesEcb(UDP_KEY, msg, false).toString('utf8'));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(msg.toString('utf8'));
  } catch {
    return null;
  }
}
