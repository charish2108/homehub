/**
 * Shelly driver — talks to the device's built-in HTTP REST API (Gen1 and Gen2+).
 * Gen1:  GET /status,   POST /control?id=0&turn=on|off
 * Gen2:  GET /rpc/Shelly.GetStatus, POST /rpc/Switch.Set?id=0{"on":true}
 *
 * Config options: { gen: 1|2 }  (auto-detected if omitted)
 */
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { http } from '../util';

export class ShellyDriver implements DeviceDriver {
  readonly label = 'Shelly';
  readonly actions: ActionDef[] = [
    { name: 'toggle_power', label: 'Power on/off' },
    { name: 'power_on', label: 'Power on' },
    { name: 'power_off', label: 'Power off' },
  ];

  private state: DeviceState = {};
  private gen?: 1 | 2;

  constructor(
    private host: string,
    opts: Record<string, any>,
  ) {
    this.gen = opts.gen === 1 || opts.gen === 2 ? opts.gen : undefined;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async poll(): Promise<DeviceState | null> {
    try {
      if (this.gen !== 2) {
        const r = await http(`http://${this.host}/status`, { timeoutMs: 3500 });
        if (r.status === 200 && r.json) {
          this.gen = 1;
          const relays = r.json.relays ?? [];
          const meters = r.json.meters ?? [];
          this.state = {
            power: !!relays[0]?.ison,
            energyW: meters[0]?.power ?? relays[0]?.power,
            online: true,
          };
          return { ...this.state };
        }
      }
    } catch {
      /* fall through to gen2 probe */
    }
    try {
      const r = await http(`http://${this.host}/rpc/Shelly.GetStatus`, { timeoutMs: 3500 });
      if (r.status === 200 && r.json) {
        this.gen = 2;
        const sw = r.json.switch?.['0'] ?? r.json['switch:0'] ?? {};
        this.state = {
          power: !!sw.output,
          energyW: sw.apower,
          online: true,
        };
        return { ...this.state };
      }
      return null;
    } catch {
      return null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    const on = name === 'power_on' ? true : name === 'power_off' ? false : !this.state.power;
    if (this.gen === 2) {
      const r = await http(`http://${this.host}/rpc/Switch.Set`, {
        method: 'POST',
        body: { id: 0, on },
        timeoutMs: 3500,
      });
      if (r.status !== 200) throw new Error(`Shelly error ${r.status}`);
    } else {
      const r = await http(`http://${this.host}/control?id=0&turn=${on ? 'on' : 'off'}`, {
        timeoutMs: 3500,
      });
      if (r.status !== 200) throw new Error(`Shelly error ${r.status}`);
    }
    this.state.power = on;
  }
}
