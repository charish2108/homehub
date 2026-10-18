/** Core types shared across the hub. */

export type DeviceClass =
  | 'tv'
  | 'ac'
  | 'washer'
  | 'dryer'
  | 'fridge'
  | 'light'
  | 'plug'
  | 'speaker'
  | 'vacuum'
  | 'other';

export interface DeviceState {
  power?: boolean;
  // climate / AC
  targetTemperature?: number;
  currentTemperature?: number;
  mode?: string; // cool | heat | dry | fan | auto
  fan?: string; // auto | low | medium | high
  swing?: boolean;
  humidity?: number;
  // washer / dryer
  running?: boolean;
  program?: string;
  phase?: string; // idle | washing | rinsing | spinning | drying | finished
  remainingMinutes?: number;
  doorOpen?: boolean;
  // TV
  volume?: number;
  muted?: boolean;
  channel?: string;
  input?: string;
  app?: string;
  // light / plug
  brightness?: number; // 0-100
  colorTemp?: number; // kelvin
  energyW?: number;
  // free-form extras
  [key: string]: unknown;
}

export interface ActionParam {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'enum';
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default?: unknown;
}

export interface ActionDef {
  name: string;
  label: string;
  params?: ActionParam[];
}

export interface DeviceConfig {
  id: string;
  name: string;
  room: string;
  class: DeviceClass;
  driver: string;
  host?: string;
  manufacturer?: string;
  model?: string;
  /** Driver-specific options (ports, keys, dp maps, IR codes...). */
  options?: Record<string, any>;
  /** Poll interval in ms; drivers may suggest their own default. */
  pollMs?: number;
}

export interface DeviceInfo extends Omit<DeviceConfig, 'options'> {
  online: boolean;
  state: DeviceState;
  actions: ActionDef[];
  driverLabel: string;
  lastSeenMs: number;
}

export interface HubEvent {
  type: 'state' | 'device_added' | 'device_removed' | 'discovery' | 'log';
  devices?: DeviceInfo[];
  device?: DeviceInfo;
  discovery?: DiscoveryResult[];
  message?: string;
  ts: number;
}

export interface DiscoveryResult {
  id: string;
  host: string;
  port?: number;
  name?: string;
  services: string[];
  source: 'ssdp' | 'mdns' | 'probe';
  raw?: Record<string, string>;
  suggestedDriver?: 'samsung-tv' | 'lg-webos' | 'shelly' | 'hue' | 'sony-bravia';
  suggestedClass?: DeviceClass;
  addedDeviceId?: string;
  pairingRequired?: boolean;
  setupNote?: string;
}

/** Driver contract implemented by everything in drivers/. */
export interface DeviceDriver {
  /** Human readable driver name shown in the UI. */
  readonly label: string;
  /** Actions the app can invoke on this device. */
  readonly actions: ActionDef[];
  /** Start connecting / listening. Should not throw for offline devices. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Return fresh state, or null if the device is unreachable. */
  poll(): Promise<DeviceState | null>;
  /** Execute a named action. Throw Error with a friendly message on failure. */
  action(name: string, params: Record<string, any>): Promise<void>;
}
