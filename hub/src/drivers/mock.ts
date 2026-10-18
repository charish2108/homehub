/** Mock driver: simulates appliances so the whole stack works with zero hardware. */
import { ActionDef, DeviceDriver, DeviceState } from '../types';

type Flavor = 'tv' | 'ac' | 'washer' | 'light' | 'plug';

export class MockDriver implements DeviceDriver {
  readonly label = 'Demo (simulated)';
  readonly actions: ActionDef[];
  private state: DeviceState = {};
  private flavor: Flavor;
  private timer?: NodeJS.Timeout;

  constructor(options: Record<string, any> = {}) {
    this.flavor = (options.flavor as Flavor) ?? 'plug';
    this.actions = actionsFor(this.flavor);
    this.state = initial(this.flavor);
    // Simulate live appliance behaviour: washer progresses its cycle, AC drifts
    // toward target temperature, TV volume fluctuates.
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref?.();
  }

  async start(): Promise<void> {
    /* nothing to connect */
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<DeviceState | null> {
    return { ...this.state };
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    const s = this.state;
    switch (name) {
      case 'power_on':
        s.power = true;
        if (this.flavor === 'washer') {
          s.running = true;
          s.phase = 'washing';
          s.remainingMinutes = 82;
        }
        break;
      case 'power_off':
        s.power = false;
        if (this.flavor === 'washer') {
          s.running = false;
          s.phase = 'idle';
          s.remainingMinutes = 0;
        }
        break;
      case 'toggle_power':
        await this.action(s.power ? 'power_off' : 'power_on', {});
        break;
      case 'volume_set':
        s.volume = clamp(Number(params.value), 0, 100);
        s.muted = false;
        break;
      case 'volume_up':
        s.volume = clamp((s.volume ?? 20) + 1, 0, 100);
        s.muted = false;
        break;
      case 'volume_down':
        s.volume = clamp((s.volume ?? 20) - 1, 0, 100);
        break;
      case 'mute_toggle':
        s.muted = !s.muted;
        break;
      case 'channel_set':
        s.channel = String(params.value ?? '');
        break;
      case 'remote_key':
        // Directional keys move a fake selection; Enter toggles a fake app.
        if (params.key === 'ENTER') s.app = s.app ? undefined : 'Netflix';
        if (params.key === 'BACK') s.app = undefined;
        break;
      case 'input_set':
        s.input = String(params.value ?? '');
        break;
      case 'temperature_set':
        s.targetTemperature = clamp(Number(params.value), 16, 30);
        break;
      case 'temperature_up':
        s.targetTemperature = clamp((s.targetTemperature ?? 24) + 1, 16, 30);
        break;
      case 'temperature_down':
        s.targetTemperature = clamp((s.targetTemperature ?? 24) - 1, 16, 30);
        break;
      case 'mode_set':
        s.mode = String(params.value ?? 'cool');
        break;
      case 'fan_set':
        s.fan = String(params.value ?? 'auto');
        break;
      case 'swing_toggle':
        s.swing = !s.swing;
        break;
      case 'brightness_set':
        s.brightness = clamp(Number(params.value), 0, 100);
        break;
      case 'start':
        s.running = true;
        s.phase = 'washing';
        s.remainingMinutes = Number(params.minutes ?? 82);
        break;
      case 'pause':
        s.running = false;
        s.phase = s.phase === 'idle' ? 'idle' : 'paused';
        break;
      case 'stop':
        s.running = false;
        s.phase = 'idle';
        s.remainingMinutes = 0;
        break;
      case 'program_set':
        s.program = String(params.value ?? s.program);
        break;
      default:
        throw new Error(`Demo device does not support "${name}"`);
    }
  }

  private tick(): void {
    const s = this.state;
    if (this.flavor === 'washer' && s.running) {
      s.remainingMinutes = Math.max(0, (s.remainingMinutes ?? 0) - 1);
      const left = s.remainingMinutes as number;
      s.phase = left === 0 ? 'finished' : left > 60 ? 'washing' : left > 20 ? 'rinsing' : 'spinning';
      if (left === 0) s.running = false;
    }
    if (this.flavor === 'ac' && s.power) {
      const cur = s.currentTemperature ?? 29;
      const target = s.targetTemperature ?? 24;
      if (cur > target) s.currentTemperature = +(cur - 0.5).toFixed(1);
      else if (cur < target) s.currentTemperature = +(cur + 0.5).toFixed(1);
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function initial(flavor: Flavor): DeviceState {
  switch (flavor) {
    case 'tv':
      return { power: true, volume: 12, muted: false, input: 'HDMI 1' };
    case 'ac':
      return { power: true, targetTemperature: 24, currentTemperature: 29, mode: 'cool', fan: 'auto', swing: false };
    case 'washer':
      return { power: false, running: false, program: 'Cotton 60°', phase: 'idle', remainingMinutes: 0, doorOpen: false };
    case 'light':
      return { power: true, brightness: 80 };
    case 'plug':
      return { power: false, energyW: 0 };
  }
}

function actionsFor(flavor: Flavor | 'dryer'): ActionDef[] {
  const common: ActionDef[] = [{ name: 'toggle_power', label: 'Power on/off' }];
  switch (flavor) {
    case 'tv':
      return [
        ...common,
        { name: 'remote_key', label: 'Remote key', params: [{ name: 'key', type: 'enum', options: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'EXIT', 'PLAY', 'PAUSE', 'SOURCE'] }] },
        { name: 'volume_set', label: 'Set volume', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] },
        { name: 'mute_toggle', label: 'Mute' },
        { name: 'channel_set', label: 'Set channel', params: [{ name: 'value', type: 'string' }] },
        { name: 'input_set', label: 'Set input', params: [{ name: 'value', type: 'string' }] },
      ];
    case 'ac':
      return [
        ...common,
        { name: 'temperature_set', label: 'Set temperature', params: [{ name: 'value', type: 'number', min: 16, max: 30 }] },
        { name: 'mode_set', label: 'Set mode', params: [{ name: 'value', type: 'enum', options: ['cool', 'heat', 'dry', 'fan', 'auto'] }] },
        { name: 'fan_set', label: 'Fan speed', params: [{ name: 'value', type: 'enum', options: ['auto', 'low', 'medium', 'high'] }] },
        { name: 'swing_toggle', label: 'Swing' },
      ];
    case 'washer':
    case 'dryer':
      return [
        { name: 'power_on', label: 'Start' },
        { name: 'pause', label: 'Pause' },
        { name: 'stop', label: 'Stop' },
        { name: 'program_set', label: 'Select program', params: [{ name: 'value', type: 'string' }] },
      ];
    case 'light':
      return [...common, { name: 'brightness_set', label: 'Brightness', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] }];
    case 'plug':
      return [...common];
  }
}
