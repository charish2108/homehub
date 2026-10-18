/**
 * MQTT driver — bridges any MQTT-controlled appliance (Tasmota, ESPHome,
 * Zigbee2MQTT, custom firmware) into the hub.
 *
 * Config options:
 *   url                    (required) "mqtt://192.168.1.10:1883"
 *   username / password             (optional)
 *   stateTopic             (required) topic publishing JSON or raw state
 *   commandTopic                     topic to publish commands to
 *   powerCommandOn / powerCommandOff (default "ON" / "OFF")
 *   brightnessTopic / temperatureTopic / modeTopic   (optional extra state topics)
 *   availabilityTopic / availableValue / unavailableValue  (optional LWT)
 *   map                              JSON-pointer map for JSON state payloads
 */
import { ActionDef, DeviceDriver, DeviceState, DeviceClass } from '../types';
import * as mqtt from 'mqtt';
import { assertPrivateHost } from '../util';

export class MqttDriver implements DeviceDriver {
  readonly label = 'MQTT';
  readonly actions: ActionDef[];

  private client?: mqtt.MqttClient;
  private state: DeviceState = {};
  private online = false;

  constructor(
    private deviceClass: DeviceClass,
    private opts: Record<string, any>,
  ) {
    this.actions = actionsFor(deviceClass);
  }

  async start(): Promise<void> {
    const url = String(this.opts.url ?? '');
    if (!url) throw new Error('mqtt driver requires options.url');
    let broker: URL;
    try {
      broker = new URL(url);
    } catch {
      throw new Error('mqtt driver options.url must be a valid mqtt:// or mqtts:// URL');
    }
    if (!['mqtt:', 'mqtts:'].includes(broker.protocol) || broker.username || broker.password) {
      throw new Error('MQTT broker URL must use mqtt(s) without embedded credentials');
    }
    await assertPrivateHost(broker.hostname);
    this.client = mqtt.connect(url, {
      username: this.opts.username || undefined,
      password: this.opts.password || undefined,
      connectTimeout: 5000,
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      this.online = true;
      const subs = [this.opts.stateTopic, this.opts.brightnessTopic, this.opts.temperatureTopic, this.opts.availabilityTopic].filter(Boolean);
      for (const topic of subs) this.client!.subscribe(String(topic));
    });
    this.client.on('error', () => {
      this.online = false;
    });
    this.client.on('close', () => {
      this.online = false;
    });
    this.client.on('message', (topic, payload) => this.onMessage(String(topic), payload.toString()));
  }

  async stop(): Promise<void> {
    this.client?.end(true);
  }

  async poll(): Promise<DeviceState | null> {
    return this.online ? { ...this.state } : null;
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    const topic = String(this.opts.commandTopic ?? '');
    if (!topic || !this.client) throw new Error('MQTT device has no commandTopic configured');
    let message: string;
    switch (name) {
      case 'power_on':
        message = String(this.opts.powerCommandOn ?? 'ON');
        break;
      case 'power_off':
        message = String(this.opts.powerCommandOff ?? 'OFF');
        break;
      case 'toggle_power':
        message = this.state.power ? String(this.opts.powerCommandOff ?? 'OFF') : String(this.opts.powerCommandOn ?? 'ON');
        break;
      case 'brightness_set':
        message = String(Math.max(0, Math.min(100, Number(params.value))));
        break;
      case 'temperature_set':
        message = String(Number(params.value));
        break;
      case 'mode_set':
        message = String(params.value);
        break;
      case 'raw':
        message = String(params.message);
        break;
      default:
        throw new Error(`MQTT device does not support "${name}"`);
    }
    await new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, message, (err) => (err ? reject(err) : resolve()));
    });
  }

  private onMessage(topic: string, payload: string): void {
    if (this.opts.availabilityTopic && topic === this.opts.availabilityTopic) {
      this.online = payload !== String(this.opts.unavailableValue ?? 'offline');
      return;
    }
    if (topic === this.opts.brightnessTopic) {
      this.state.brightness = Number(payload);
      return;
    }
    if (topic === this.opts.temperatureTopic) {
      this.state.currentTemperature = Number(payload);
      return;
    }
    if (topic === this.opts.modeTopic) {
      this.state.mode = payload;
      return;
    }
    if (topic !== this.opts.stateTopic) return;
    try {
      const json = JSON.parse(payload);
      const map = this.opts.map ?? {};
      for (const [field, pointer] of Object.entries(map as Record<string, string>)) {
        const value = jsonPointer(json, pointer);
        if (value !== undefined) (this.state as any)[field] = value;
      }
      if (Object.keys(map).length === 0) {
        // No map: assume Tasmota-style single-switch JSON {"POWER":"ON"} or {"POWER":"ON","POWER2":...}
        const key = Object.keys(json).find((k) => k.startsWith('POWER'));
        if (key) this.state.power = json[key] === 'ON';
      }
    } catch {
      // Raw payload: treat as power state.
      this.state.power = payload === 'ON' || payload === 'on' || payload === 'true' || payload === '1';
    }
  }
}

function jsonPointer(obj: any, pointer: string): any {
  if (!pointer) return obj;
  return pointer
    .replace(/^\//, '')
    .split('/')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function actionsFor(cls: DeviceClass): ActionDef[] {
  const common: ActionDef[] = [
    { name: 'toggle_power', label: 'Power on/off' },
    { name: 'power_on', label: 'Power on' },
    { name: 'power_off', label: 'Power off' },
  ];
  switch (cls) {
    case 'light':
      return [...common, { name: 'brightness_set', label: 'Brightness', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] }];
    case 'ac':
      return [
        ...common,
        { name: 'temperature_set', label: 'Set temperature', params: [{ name: 'value', type: 'number', min: 16, max: 30 }] },
        { name: 'mode_set', label: 'Set mode', params: [{ name: 'value', type: 'enum', options: ['cool', 'heat', 'dry', 'fan', 'auto'] }] },
      ];
    default:
      return [...common, { name: 'raw', label: 'Raw publish', params: [{ name: 'message', type: 'string' }] }];
  }
}
