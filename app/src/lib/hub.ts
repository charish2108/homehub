import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEFAULT_HUB_URL = 'http://192.168.1.50:8321';
const HUB_URL_KEY = 'homehub:url';
const HUB_TOKEN_KEY = 'homehub:token';

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

export interface DeviceState {
  power?: boolean;
  targetTemperature?: number;
  currentTemperature?: number;
  mode?: string;
  fan?: string;
  swing?: boolean;
  humidity?: number;
  running?: boolean;
  program?: string;
  phase?: string;
  remainingMinutes?: number;
  doorOpen?: boolean;
  volume?: number;
  muted?: boolean;
  channel?: string;
  input?: string;
  app?: string;
  brightness?: number;
  colorTemp?: number;
  energyW?: number;
  [key: string]: unknown;
}

export interface DeviceInfo {
  id: string;
  name: string;
  room: string;
  class: DeviceClass;
  driver: string;
  manufacturer?: string;
  model?: string;
  online: boolean;
  state: DeviceState;
  actions: ActionDef[];
  driverLabel: string;
  lastSeenMs: number;
}

export interface HubSettings {
  url: string;
  token: string;
}

export interface HubSocketEvent {
  type: 'hello' | 'state' | 'device_added' | 'device_removed' | 'discovery' | 'log' | 'pong' | 'actionResult';
  homeName?: string;
  devices?: DeviceInfo[];
  device?: DeviceInfo;
  ts?: number;
  requestId?: string;
  ok?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface DiscoveryResult {
  id: string;
  host: string;
  port?: number;
  name?: string;
  services: string[];
  source: 'ssdp' | 'mdns' | 'probe';
  suggestedDriver?: 'samsung-tv' | 'lg-webos' | 'shelly' | 'hue' | 'sony-bravia';
  suggestedClass?: DeviceClass;
  addedDeviceId?: string;
  pairingRequired?: boolean;
  setupNote?: string;
}

export interface DiscoveryResponse {
  found: DiscoveryResult[];
  hint?: string;
}

export async function loadHubSettings(): Promise<HubSettings> {
  const [url, token] = await Promise.all([
    AsyncStorage.getItem(HUB_URL_KEY),
    AsyncStorage.getItem(HUB_TOKEN_KEY),
  ]);

  return {
    url: url && url.trim() ? url.trim() : DEFAULT_HUB_URL,
    token: token ?? '',
  };
}

export async function saveHubSettings(settings: HubSettings): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(HUB_URL_KEY, settings.url.trim() || DEFAULT_HUB_URL),
    AsyncStorage.setItem(HUB_TOKEN_KEY, settings.token ?? ''),
  ]);
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

export async function fetchDevices(settings: HubSettings): Promise<DeviceInfo[]> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices`, {
    method: 'GET',
    headers: buildHeaders(settings.token),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to load devices (${response.status})`);
  }

  const json = (await response.json()) as { devices?: DeviceInfo[]; rooms?: string[]; homeName?: string };
  return Array.isArray(json.devices) ? json.devices : [];
}

export async function discoverDevices(settings: HubSettings): Promise<DiscoveryResponse> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/discover`, {
    method: 'POST',
    headers: buildHeaders(settings.token),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Network discovery failed (${response.status})`);
  }

  const json = (await response.json()) as Partial<DiscoveryResponse>;
  if (!Array.isArray(json.found)) {
    throw new Error('Hub returned an invalid discovery response');
  }
  return { found: json.found, hint: json.hint };
}

export async function addDiscoveredDevice(settings: HubSettings, discoveryId: string): Promise<DeviceInfo> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/discovered`, {
    method: 'POST',
    headers: {
      ...buildHeaders(settings.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ discoveryId }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Could not add discovered device (${response.status})`);
  }
  const result = (await response.json()) as { device?: DeviceInfo };
  if (!result.device?.id) throw new Error('Hub returned an invalid added-device response');
  return result.device;
}

export async function startSonyPairing(settings: HubSettings, discoveryId: string): Promise<{ sessionId: string; name: string }> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/discovered/pair`, {
    method: 'POST',
    headers: { ...buildHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ discoveryId }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Could not start TV pairing (${response.status})`);
  }
  const result = (await response.json()) as { sessionId?: string; name?: string };
  if (!result.sessionId) throw new Error('Hub returned an invalid TV pairing response');
  return { sessionId: result.sessionId, name: result.name ?? 'Sony BRAVIA TV' };
}

export async function completeSonyPairing(settings: HubSettings, sessionId: string, code: string): Promise<DeviceInfo> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/discovered/pair/confirm`, {
    method: 'POST',
    headers: { ...buildHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Could not pair the TV (${response.status})`);
  }
  const result = (await response.json()) as { device?: DeviceInfo };
  if (!result.device?.id) throw new Error('Hub returned an invalid paired-device response');
  return result.device;
}

export async function cancelSonyPairing(settings: HubSettings, sessionId: string): Promise<void> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/discovered/pair/cancel`, {
    method: 'POST',
    headers: { ...buildHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Could not cancel TV pairing (${response.status})`);
  }
}

export async function checkHubConnection(settings: HubSettings): Promise<{ homeName: string; devices: number }> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/status`, {
    method: 'GET',
    headers: buildHeaders(settings.token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Hub check failed (${response.status})`);
  }
  const result = (await response.json()) as { homeName?: string; devices?: number };
  return { homeName: result.homeName ?? 'HomeHub', devices: result.devices ?? 0 };
}

export async function fetchDevice(settings: HubSettings, id: string): Promise<DeviceInfo> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: buildHeaders(settings.token),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to load device (${response.status})`);
  }

  return ((await response.json()) as DeviceInfo) ?? null;
}

export async function sendDeviceAction(
  settings: HubSettings,
  id: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const response = await fetch(`${normalizeUrl(settings.url)}/api/devices/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    headers: {
      ...buildHeaders(settings.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, params }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Action failed (${response.status})`);
  }
}

export function connectHubSocket(settings: HubSettings, onMessage: (event: HubSocketEvent) => void): WebSocket {
  const url = normalizeUrl(settings.url).replace(/^http/, 'ws');
  const protocols = settings.token
    ? ['homehub', `homehub-auth.${settings.token}`]
    : ['homehub'];
  const ws = new WebSocket(`${url}/ws`, protocols);

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as HubSocketEvent;
      onMessage(payload);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onerror = () => {
    // socket errors are treated as reconnect opportunities in the caller
  };

  return ws;
}

export function removeDeviceById(existing: DeviceInfo[], id: string | undefined): DeviceInfo[] {
  if (!id) return existing;
  return existing.filter((device) => device.id !== id);
}

export function mergeDeviceUpdate(existing: DeviceInfo[], next: DeviceInfo | DeviceInfo[] | undefined): DeviceInfo[] {
  if (!next) return existing;
  const incoming = Array.isArray(next) ? next : [next];
  const map = new Map(existing.map((device) => [device.id, device]));

  for (const device of incoming) {
    map.set(device.id, device);
  }

  return [...map.values()];
}
