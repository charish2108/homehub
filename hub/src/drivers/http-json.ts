/**
 * Generic HTTP/JSON driver — for any appliance with a simple local HTTP API
 * (DIY ESP devices, some soundbars/vacuums, bridged IR bases...).
 *
 * Config options:
 *   statusUrl   (required) GET endpoint returning JSON
 *   actions: {
 *     power_on:   { url, method?, body? },
 *     power_off:  { url, method?, body? },
 *     ...any action name
 *   }
 *   map: { power: "status.power", targetTemperature: "climate.target", ... }
 *        JSON-pointer style paths into the status response
 *   headers: { Authorization: "Bearer ..." }
 */
import { ActionDef, DeviceDriver, DeviceState, DeviceClass } from '../types';
import { http } from '../util';

export class HttpJsonDriver implements DeviceDriver {
  readonly label = 'HTTP/JSON';
  readonly actions: ActionDef[];

  private state: DeviceState = {};
  private readonly statusUrl: string;
  private readonly actionDefs: Record<string, { url: string; method?: string; body?: unknown }>;

  constructor(
    _cls: DeviceClass,
    private opts: Record<string, any>,
  ) {
    this.statusUrl = String(opts.statusUrl ?? '');
    if (!this.statusUrl) throw new Error('http-json driver requires options.statusUrl');
    this.actionDefs = opts.actions ?? {
      power_on: { url: this.statusUrl, method: 'POST', body: { power: true } },
      power_off: { url: this.statusUrl, method: 'POST', body: { power: false } },
      toggle_power: { url: this.statusUrl, method: 'POST', body: { toggle: true } },
    };
    this.actions = [
      { name: 'toggle_power', label: 'Power on/off' },
      { name: 'power_on', label: 'Power on' },
      { name: 'power_off', label: 'Power off' },
      ...Object.keys(this.actionDefs)
        .filter((k) => !['power_on', 'power_off', 'toggle_power'].includes(k))
        .map((k) => ({ name: k, label: k.replace(/_/g, ' ') })),
    ];
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async poll(): Promise<DeviceState | null> {
    try {
      const r = await http(this.statusUrl, { timeoutMs: 4000, headers: this.opts.headers ?? {} });
      if (r.status !== 200 || !r.json) return null;
      const map: Record<string, string> = this.opts.map ?? { power: '/power' };
      const state: DeviceState = {};
      for (const [field, pointer] of Object.entries(map)) {
        const value = pointer.split('/').filter(Boolean).reduce((acc: any, key) => (acc == null ? undefined : acc[key]), r.json);
        if (value !== undefined) state[field] = value;
      }
      this.state = state;
      return { ...state };
    } catch {
      return null;
    }
  }

  async action(name: string, _params: Record<string, any>): Promise<void> {
    const def = this.actionDefs[name];
    if (!def) throw new Error(`No HTTP mapping for action "${name}"`);
    const r = await http(def.url, {
      method: def.method ?? 'POST',
      body: def.body,
      timeoutMs: 4000,
      headers: this.opts.headers ?? {},
    });
    if (r.status >= 400) throw new Error(`Device returned HTTP ${r.status}`);
  }
}
