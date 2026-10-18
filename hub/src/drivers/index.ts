/** Driver factory. Maps the `driver` field in config.json to an implementation. */
import { DeviceConfig, DeviceDriver } from '../types';
import { MockDriver } from './mock';
import { SamsungTvDriver } from './samsung-tv';
import { LgWebosDriver } from './lg-webos';
import { TuyaDriver } from './tuya';
import { ShellyDriver } from './shelly';
import { HueDriver } from './hue';
import { MqttDriver } from './mqtt';
import { BroadlinkIrDriver } from './broadlink';
import { HttpJsonDriver } from './http-json';
import { SonyBraviaDriver } from './sony-bravia';

export const DRIVER_NAMES = [
  'mock',
  'samsung-tv',
  'lg-webos',
  'tuya',
  'shelly',
  'hue',
  'mqtt',
  'broadlink-ir',
  'http-json',
  'sony-bravia',
] as const;

export function createDriver(cfg: DeviceConfig): DeviceDriver {
  const opts = cfg.options ?? {};
  switch (cfg.driver) {
    case 'mock':
      return new MockDriver(opts);
    case 'samsung-tv':
      return new SamsungTvDriver(cfg.host!, opts);
    case 'lg-webos':
      return new LgWebosDriver(cfg.host!, opts);
    case 'tuya':
      return new TuyaDriver(cfg.host!, opts);
    case 'shelly':
      return new ShellyDriver(cfg.host!, opts);
    case 'hue':
      return new HueDriver(cfg.host!, opts);
    case 'mqtt':
      return new MqttDriver(cfg.class, opts);
    case 'broadlink-ir':
      return new BroadlinkIrDriver(cfg.host!, cfg.class, opts);
    case 'http-json':
      return new HttpJsonDriver(cfg.class, opts);
    case 'sony-bravia': {
      const cert = opts.cert;
      if (typeof cert !== 'object' || cert === null
          || typeof cert.key !== 'string' || typeof cert.cert !== 'string') {
        throw new Error('Sony BRAVIA driver requires a completed TV pairing certificate');
      }
      const key = Buffer.from(cert.key, 'base64');
      const certificate = Buffer.from(cert.cert, 'base64');
      if (!key.length || key.toString('base64') !== cert.key
          || !certificate.length || certificate.toString('base64') !== cert.cert) {
        throw new Error('Sony BRAVIA pairing certificate in hub config is invalid');
      }
      return new SonyBraviaDriver(cfg.host!, {
        key: key.toString('utf8'),
        cert: certificate.toString('utf8'),
      });
    }
    default:
      throw new Error(`Unknown driver "${cfg.driver}". Known: ${DRIVER_NAMES.join(', ')}`);
  }
}
