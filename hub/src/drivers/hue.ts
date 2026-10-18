/**
 * Philips Hue driver — local bridge REST API.
 * Config options: { username: "<bridge api key>", lightId: 1 }
 * The username comes from pressing the bridge button and POSTing to /api.
 */
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { http } from '../util';

export class HueDriver implements DeviceDriver {
  readonly label = 'Philips Hue';
  readonly actions: ActionDef[] = [
    { name: 'toggle_power', label: 'Light on/off' },
    { name: 'power_on', label: 'Light on' },
    { name: 'power_off', label: 'Light off' },
    { name: 'brightness_set', label: 'Brightness', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] },
  ];

  private state: DeviceState = {};
  private readonly user: string;
  private readonly lightId: string;

  constructor(
    private host: string,
    opts: Record<string, any>,
  ) {
    this.user = String(opts.username ?? '');
    this.lightId = String(opts.lightId ?? '1');
    if (!this.user) throw new Error('hue driver requires options.username (bridge API key)');
  }

  private url(path: string): string {
    return `http://${this.host}/api/${this.user}/${path}`;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async poll(): Promise<DeviceState | null> {
    try {
      const r = await http(this.url(`lights/${this.lightId}`), { timeoutMs: 3500 });
      if (r.status !== 200 || !r.json) return null;
      const on = !!r.json.state?.on;
      this.state = {
        power: on,
        brightness: r.json.state?.bri !== undefined ? Math.round((r.json.state.bri / 254) * 100) : undefined,
        colorTemp: r.json.state?.ct ? Math.round(1000000 / r.json.state.ct) : undefined,
      };
      return { ...this.state };
    } catch {
      return null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    let body: Record<string, unknown>;
    switch (name) {
      case 'power_on':
        body = { on: true };
        break;
      case 'power_off':
        body = { on: false };
        break;
      case 'toggle_power':
        body = { on: !this.state.power };
        break;
      case 'brightness_set': {
        const pct = Math.max(0, Math.min(100, Number(params.value)));
        body = { bri: Math.round((pct / 100) * 254), on: pct > 0 };
        break;
      }
      default:
        throw new Error(`Hue light does not support "${name}"`);
    }
    const r = await http(this.url(`lights/${this.lightId}/state`), {
      method: 'PUT',
      body,
      timeoutMs: 3500,
    });
    if (r.status !== 200) throw new Error(`Hue error ${r.status}`);
  }
}
