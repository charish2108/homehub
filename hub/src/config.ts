/** Loads hub configuration from config.json (path overridable via HUB_CONFIG). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { DeviceConfig } from './types';

export interface HubConfig {
  port: number;
  bind: string;
  token: string;
  homeName: string;
  corsOrigins: string[];
  devices: DeviceConfig[];
  discovery: {
    enabled: boolean;
    ssdp: boolean;
    mdns: boolean;
    /** Extra HTTP hosts to probe as potential devices. */
    probeHosts: string[];
  };
}

const DEFAULTS = {
  port: 8321,
  bind: '0.0.0.0',
  homeName: 'My Home',
};

const DEVICE_CLASSES = new Set<DeviceConfig['class']>([
  'tv', 'ac', 'washer', 'dryer', 'fridge', 'light', 'plug', 'speaker', 'vacuum', 'other',
]);

export function configPath(): string {
  return process.env.HUB_CONFIG
    ? path.resolve(process.env.HUB_CONFIG)
    : path.join(process.cwd(), 'config.json');
}

export function persistConfig(config: HubConfig): void {
  validateConfig(config);
  const file = configPath();
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function loadConfig(): { config: HubConfig; createdConfig: boolean } {
  const file = configPath();
  if (!fs.existsSync(file)) {
    const token = crypto.randomBytes(18).toString('base64url');
    const config: HubConfig = {
      port: DEFAULTS.port,
      bind: DEFAULTS.bind,
      token,
      homeName: DEFAULTS.homeName,
      corsOrigins: ['null'],
      devices: [],
      discovery: { enabled: true, ssdp: true, mdns: true, probeHosts: [] },
    };
    validateConfig(config);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    return { config, createdConfig: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`Invalid JSON in ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isRecord(parsed)) throw new Error('Hub configuration must be a JSON object');
  const raw = parsed as Partial<HubConfig>;
  if (raw.discovery !== undefined && !isRecord(raw.discovery)) {
    throw new Error('discovery must be an object');
  }
  const config: HubConfig = {
    port: raw.port === undefined ? DEFAULTS.port : raw.port,
    bind: raw.bind === undefined ? DEFAULTS.bind : raw.bind,
    token: raw.token === undefined ? '' : raw.token,
    homeName: raw.homeName === undefined ? DEFAULTS.homeName : raw.homeName,
    corsOrigins: raw.corsOrigins === undefined ? ['null'] : raw.corsOrigins,
    devices: raw.devices === undefined ? [] : raw.devices,
    discovery: {
      enabled: raw.discovery?.enabled === undefined ? true : raw.discovery.enabled,
      ssdp: raw.discovery?.ssdp === undefined ? true : raw.discovery.ssdp,
      mdns: raw.discovery?.mdns === undefined ? true : raw.discovery.mdns,
      probeHosts: raw.discovery?.probeHosts === undefined ? [] : raw.discovery.probeHosts,
    },
  };
  if (config.token === '') {
    config.token = crypto.randomBytes(18).toString('base64url');
    validateConfig(config);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    return { config, createdConfig: false };
  }
  validateConfig(config);
  return { config, createdConfig: false };
}

export function validateConfig(config: HubConfig): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('Hub port must be an integer between 1 and 65535');
  }
  if (typeof config.bind !== 'string') throw new Error('bind address must be a string');
  validateAscii(config.bind, 'bind address');
  if (config.bind !== '0.0.0.0' && config.bind !== '::' && config.bind !== 'localhost' && !isPrivateBind(config.bind)) {
    throw new Error('Hub bind address must be a private IP, localhost, or an all-interface address');
  }
  if (typeof config.homeName !== 'string') throw new Error('home name must be a string');
  if (typeof config.token !== 'string') throw new Error('hub token must be a string');
  validateAscii(config.homeName, 'home name');
  validateAscii(config.token, 'hub token');
  if (config.token && !/^[A-Za-z0-9_-]{16,}$/.test(config.token)) {
    throw new Error('Hub token must contain at least 16 base64url characters');
  }
  if (!Array.isArray(config.corsOrigins)) throw new Error('corsOrigins must be an array');
  for (const [index, origin] of config.corsOrigins.entries()) {
    if (typeof origin !== 'string' || (origin !== 'null' && !isHttpOrigin(origin))) {
      throw new Error(`corsOrigins[${index}] must be "null" or an HTTP(S) origin`);
    }
    validateAscii(origin, `corsOrigins[${index}]`);
  }
  if (!Array.isArray(config.devices)) throw new Error('devices must be an array');
  const ids = new Set<string>();
  for (const [index, device] of config.devices.entries()) {
    if (!isRecord(device)) throw new Error(`devices[${index}] must be an object`);
    for (const field of ['id', 'name', 'room', 'driver'] as const) {
      const value: unknown = device[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`devices[${index}].${field} must be a non-empty string`);
      }
      validateAscii(value, `devices[${index}].${field}`);
    }
    if (ids.has(device.id)) throw new Error(`Duplicate device id "${device.id}"`);
    ids.add(device.id);
    if (!DEVICE_CLASSES.has(device.class)) throw new Error(`devices[${index}].class is not supported`);
    if (device.host !== undefined) {
      if (typeof device.host !== 'string' || !device.host.trim()) throw new Error(`devices[${index}].host must be a non-empty string`);
      validateAscii(device.host, `devices[${index}].host`);
    }
    for (const field of ['manufacturer', 'model'] as const) {
      const value: unknown = device[field];
      if (value !== undefined && typeof value !== 'string') throw new Error(`devices[${index}].${field} must be a string`);
      if (typeof value === 'string') validateAscii(value, `devices[${index}].${field}`);
    }
    if (device.pollMs !== undefined && (!Number.isFinite(device.pollMs) || device.pollMs < 250)) {
      throw new Error(`devices[${index}].pollMs must be at least 250ms`);
    }
    validateAsciiValues(device.options, `devices[${index}].options`);
  }
  if (!isRecord(config.discovery)) throw new Error('discovery must be an object');
  for (const key of ['enabled', 'ssdp', 'mdns'] as const) {
    if (typeof config.discovery[key] !== 'boolean') throw new Error(`discovery.${key} must be a boolean`);
  }
  if (!Array.isArray(config.discovery.probeHosts)) throw new Error('discovery.probeHosts must be an array');
  for (const [index, host] of config.discovery.probeHosts.entries()) {
    if (typeof host !== 'string' || !host.trim()) throw new Error(`discovery.probeHosts[${index}] must be a non-empty string`);
    validateAscii(host, `discovery.probeHosts[${index}]`);
  }
}

function validateAsciiValues(value: unknown, field: string): void {
  if (typeof value === 'string') {
    validateAscii(value, field);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => validateAsciiValues(item, `${field}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateAscii(key, `${field} key`);
      validateAsciiValues(item, `${field}.${key}`);
    }
  }
}

function validateAscii(value: string, field: string): void {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new Error(`${field} must contain printable ASCII characters only`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrivateBind(address: string): boolean {
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  const [first, second, third, fourth, ...extra] = address.split('.').map(Number);
  return extra.length === 0 && [first, second, third, fourth].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first === 127);
}

function isHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && parsed.origin === value
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}
