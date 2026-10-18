/**
 * Broadlink RM (RM4 mini / RM4 pro / RM mini) driver — controls "dumb" IR
 * appliances (most ACs, TVs, fans, soundbars) by blasting learned IR codes.
 *
 * Faithful port of python-broadlink's AES-CBC session protocol (MIT).
 *
 * Config options:
 *   mac     (required) device MAC "aa:bb:cc:dd:ee:ff" (from discovery output)
 *   devType (required) numeric device type from discovery
 *   codes: {                       learned IR payloads (hex strings)
 *     power_on: "b200...",
 *     power_off: "b201...",
 *     temperature_24: "b20a...",
 *     ...
 *   }
 *   temperatures: { "24": "temperature_24", ... }  optional map
 *
 * EXPERIMENTAL: not verified against hardware in this environment.
 * Use action "learn_start" then "learn_get" to capture codes from a real remote.
 */
import * as dgram from 'node:dgram';
import * as crypto from 'node:crypto';
import { ActionDef, DeviceDriver, DeviceState, DeviceClass } from '../types';
import { assertPrivateHost } from '../util';

const INIT_KEY = Buffer.from('097628343fe99e23765c1513accf8b02', 'hex');
const INIT_VECT = Buffer.from('562e17996d093d28ddb3ba695a2e6f58', 'hex');
const DEFAULT_PORT = 8000;

export class BroadlinkIrDriver implements DeviceDriver {
  readonly label = 'Broadlink IR';
  readonly actions: ActionDef[];

  private state: DeviceState = {};
  private deviceId = 0;
  private aesKey = INIT_KEY;
  private count = Math.floor(Math.random() * 0x7fff) + 0x8000;
  private readonly mac: Buffer;
  private readonly devType: number;
  private readonly codes: Record<string, string>;
  private readonly temperatures: Record<string, string>;
  private readonly port: number;

  constructor(
    private host: string,
    deviceClass: DeviceClass,
    opts: Record<string, any>,
  ) {
    const mac = String(opts.mac ?? '')
      .replace(/[^0-9a-fA-F]/g, '')
      .padStart(12, '0');
    if (mac.length !== 12) throw new Error('broadlink-ir requires options.mac');
    this.mac = Buffer.from(mac, 'hex');
    this.devType = Number(opts.devType ?? 0x279d); // RM4 mini default
    this.codes = opts.codes ?? {};
    this.temperatures = opts.temperatures ?? {};
    this.port = Number(opts.port ?? DEFAULT_PORT);
    this.actions = [
      { name: 'toggle_power', label: 'Power on/off' },
      { name: 'power_on', label: 'Power on (IR)' },
      { name: 'power_off', label: 'Power off (IR)' },
      { name: 'send_code', label: 'Send code', params: [{ name: 'name', type: 'string' }] },
      { name: 'learn_start', label: 'Start learning a code' },
      { name: 'learn_get', label: 'Fetch learned code' },
      ...(deviceClass === 'ac'
        ? [
            { name: 'temperature_set' as const, label: 'Set temperature', params: [{ name: 'value', type: 'number' as const, min: 16, max: 30 }] },
            { name: 'mode_set' as const, label: 'Set mode', params: [{ name: 'value', type: 'enum' as const, options: ['cool', 'heat', 'dry', 'fan', 'auto'] }] },
          ]
        : []),
      ...(deviceClass === 'tv'
        ? [
            { name: 'remote_key' as const, label: 'Remote key', params: [{ name: 'key', type: 'enum' as const, options: ['POWER', 'MUTE', 'VOL_UP', 'VOL_DOWN', 'CH_UP', 'CH_DOWN', 'INPUT', 'PLAY', 'PAUSE', 'OK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'BACK', 'HOME'] }] },
          ]
        : []),
    ];
  }

  async start(): Promise<void> {
    try {
      await this.auth();
    } catch {
      /* offline; poll retries */
    }
  }

  async stop(): Promise<void> {}

  async poll(): Promise<DeviceState | null> {
    try {
      await this.auth();
      this.state.online = true;
      return { ...this.state };
    } catch {
      return null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    switch (name) {
      case 'learn_start':
        await this.learn();
        this.state.learnMode = true;
        return;
      case 'learn_get': {
        const code = await this.checkLearned();
        this.state.learnMode = false;
        this.state.lastLearnedCode = code;
        return;
      }
      case 'send_code': {
        const code = this.codes[String(params.name)];
        if (!code) throw new Error(`No IR code named "${params.name}" in config`);
        await this.sendIr(code);
        return;
      }
      case 'toggle_power':
      case 'power_on':
      case 'power_off': {
        const key = name === 'power_on' ? 'power_on' : name === 'power_off' ? 'power_off' : this.state.power ? 'power_off' : 'power_on';
        const code = this.codes[key];
        if (!code) throw new Error(`No IR code "${key}" configured (use learn_start/learn_get)`);
        await this.sendIr(code);
        this.state.power = key === 'power_on';
        return;
      }
      case 'temperature_set': {
        const value = Number(params.value);
        const codeName = this.temperatures[String(value)] ?? `temperature_${value}`;
        const code = this.codes[codeName];
        if (!code) throw new Error(`No IR code "${codeName}" configured for ${value}°C`);
        await this.sendIr(code);
        this.state.targetTemperature = value;
        return;
      }
      case 'mode_set': {
        const mode = String(params.value);
        const code = this.codes[`mode_${mode}`];
        if (!code) throw new Error(`No IR code "mode_${mode}" configured`);
        await this.sendIr(code);
        this.state.mode = mode;
        return;
      }
      case 'remote_key': {
        const code = this.codes[`key_${String(params.key).toLowerCase()}`];
        if (!code) throw new Error(`No IR code "key_${String(params.key).toLowerCase()}" configured`);
        await this.sendIr(code);
        return;
      }
      default:
        throw new Error(`Broadlink IR does not support "${name}"`);
    }
  }

  // ---- protocol ---------------------------------------------------------

  private encrypt(payload: Buffer): Buffer {
    const pad = (16 - (payload.length % 16)) % 16;
    const padded = Buffer.concat([payload, Buffer.alloc(pad)]);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.aesKey, INIT_VECT);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
  }

  private decrypt(payload: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.aesKey, INIT_VECT);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  }

  private sum16(buf: Buffer): number {
    let sum = 0;
    for (const b of buf) sum += b;
    return sum & 0xffff;
  }

  private buildPacket(type: number, payload: Buffer): Buffer {
    const packet = Buffer.alloc(0x38);
    Buffer.from('5aa5aa555aa5aa55', 'hex').copy(packet, 0);
    packet.writeUInt16LE(this.devType, 0x24);
    packet.writeUInt16LE(type, 0x26);
    this.count = ((this.count + 1) | 0x8000) & 0xffff;
    packet.writeUInt16LE(this.count, 0x28);
    Buffer.from(this.mac).reverse().copy(packet, 0x2a);
    packet.writeUInt32LE(this.deviceId, 0x30);
    packet.writeUInt16LE(this.sum16(payload), 0x34);
    const full = Buffer.concat([packet, this.encrypt(payload)]);
    full.writeUInt16LE(this.sum16(full), 0x20);
    return full;
  }

  private async exchange(type: number, payload: Buffer): Promise<Buffer> {
    await assertPrivateHost(this.host);
    const packet = this.buildPacket(type, payload);
    const socket = dgram.createSocket('udp4');
    try {
      const resp = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('Broadlink device timeout (is it powered on and reachable?)'));
        }, 4000);
        socket.on('error', (err) => {
          clearTimeout(timer);
          socket.close();
          reject(err);
        });
        socket.on('message', (msg) => {
          clearTimeout(timer);
          socket.close();
          resolve(msg);
        });
        socket.send(packet, this.port, this.host, () => {});
      });
      if (resp.length < 0x30) throw new Error('Broadlink response too short');
      const declared = resp.readUInt16LE(0x20);
      const actual = (this.sum16(resp) - resp.readUInt16LE(0x20) + 0x10000) & 0xffff;
      if (declared !== actual) throw new Error('Broadlink response checksum mismatch');
      return resp;
    } finally {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }

  private async auth(): Promise<void> {
    this.deviceId = 0;
    this.aesKey = INIT_KEY;
    const payload = Buffer.alloc(0x50, 0);
    payload.fill(0x31, 0x04, 0x14);
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    Buffer.from('Test 1').copy(payload, 0x30);
    const resp = await this.exchange(0x65, payload);
    const plain = this.decrypt(resp.subarray(0x38));
    this.deviceId = plain.readUInt32LE(0);
    this.aesKey = Buffer.from(plain.subarray(0x04, 0x14));
  }

  private async sendIr(hexCode: string): Promise<void> {
    const data = Buffer.from(hexCode, 'hex');
    await this.exchange(0x6a, Buffer.concat([Buffer.from([2, 0, 0, 0]), data]));
  }

  private async learn(): Promise<void> {
    await this.exchange(0x6a, Buffer.from([3, 0, 0, 0]));
  }

  private async checkLearned(): Promise<string> {
    const resp = await this.exchange(0x6a, Buffer.from([4, 0, 0, 0]));
    const plain = this.decrypt(resp.subarray(0x38));
    const code = plain.subarray(4, 4 + plain.readUInt16LE(2));
    if (code.length === 0) throw new Error('No code captured yet — press the remote button and retry');
    return code.toString('hex');
  }
}

/** Discover Broadlink devices on the LAN (~2s broadcast sweep). */
export async function scanBroadlink(timeoutMs = 2000): Promise<Array<{ ip: string; mac: string; devType: number; name: string }>> {
  const socket = dgram.createSocket('udp4');
  const found = new Map<string, { ip: string; mac: string; devType: number; name: string }>();
  const packet = Buffer.alloc(0x30, 0);
  const now = new Date();
  // Timestamp fields (offset 0x08) — device checks this is close to now.
  packet.writeInt32LE(-new Date().getTimezoneOffset() / 3600, 0x08);
  packet.writeUInt16LE(now.getFullYear(), 0x0c);
  packet.writeUInt8(now.getMinutes(), 0x0e);
  packet.writeUInt8(now.getHours(), 0x0f);
  packet.writeUInt8(now.getFullYear() % 100, 0x10);
  packet.writeUInt8((now.getDay() || 7) as number, 0x11);
  packet.writeUInt8(now.getDate(), 0x12);
  packet.writeUInt8(now.getMonth() + 1, 0x13);
  packet.writeUInt8(6, 0x26);
  packet.writeUInt16LE((packet.reduce((a, b) => a + b, 0) + 0xbeaf) & 0xffff, 0x20);

  await new Promise<void>((resolve) => {
    socket.on('error', () => resolve());
    socket.on('message', (msg, rinfo) => {
      try {
        const devType = msg.readUInt16LE(0x34);
        const mac = Buffer.from(msg.subarray(0x3a, 0x40)).reverse().toString('hex');
        const name = msg.subarray(0x40).toString('utf8').split('\0')[0];
        found.set(mac, { ip: rinfo.address, mac, devType, name });
      } catch {
        /* not a broadlink reply */
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, DEFAULT_PORT, '255.255.255.255', () => {});
      setTimeout(() => {
        socket.close();
        resolve();
      }, timeoutMs);
    });
  });
  return [...found.values()];
}
