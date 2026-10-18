/**
 * LG webOS TV driver (SSAP protocol over WebSocket, default port 3000).
 *
 * First connection shows a pairing prompt on the TV; confirm it once and the
 * client-key persists via options.clientKey (the hub stores what you paste in
 * config). Power-on requires "Wake on LAN" / IP control enabled in TV settings.
 */
import WebSocket from 'ws';
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { assertPrivateHost, wakeOnLan } from '../util';

export class LgWebosDriver implements DeviceDriver {
  readonly label = 'LG webOS TV';
  readonly actions: ActionDef[] = [
    { name: 'power_on', label: 'Power on (Wake-on-LAN)' },
    { name: 'power_off', label: 'Power off' },
    { name: 'remote_key', label: 'Remote key', params: [{ name: 'key', type: 'enum', options: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'EXIT', 'MENU', 'SOURCE', 'PLAY', 'PAUSE', 'STOP', 'MUTE', 'VOL_UP', 'VOL_DOWN', 'CH_UP', 'CH_DOWN'] }] },
    { name: 'volume_set', label: 'Set volume', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] },
    { name: 'volume_up', label: 'Volume up' },
    { name: 'volume_down', label: 'Volume down' },
    { name: 'mute_toggle', label: 'Mute' },
    { name: 'channel_set', label: 'Set channel', params: [{ name: 'value', type: 'string' }] },
    { name: 'input_set', label: 'Switch input', params: [{ name: 'value', type: 'string', label: 'HDMI 1 / HDMI 2 / AV ...' }] },
  ];

  private ws?: WebSocket;
  private state: DeviceState = {};
  private requestId = 0;

  constructor(
    private host: string,
    private opts: Record<string, any>,
  ) {}

  private get port(): number {
    return Number(this.opts.port ?? 3000);
  }

  async start(): Promise<void> {
    await assertPrivateHost(this.host);
    this.connect();
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = undefined;
  }

  async poll(): Promise<DeviceState | null> {
    try {
      // TV on/off state is available through the hello handshake; use socket state
      // plus ssap audio getVolume for live data.
      const vol = await this.request('ssap://audio/getVolume');
      if (vol && typeof vol === 'object') {
        const v = vol as any;
        this.state.volume = typeof v.volume === 'number' ? v.volume : this.state.volume;
        this.state.muted = v.muted ?? this.state.muted;
        this.state.power = true;
      }
      return { ...this.state };
    } catch {
      return this.state.power ? null : null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    switch (name) {
      case 'power_on':
        await wakeOnLan(this.opts.mac);
        return;
      case 'power_off':
        await this.request('ssap://system/turnOff');
        this.state.power = false;
        return;
      case 'remote_key': {
        const key = String(params.key).toUpperCase();
        if (!LG_KEYS.includes(key)) throw new Error(`Unknown key ${params.key}`);
        // webOS key injection (same route community libraries such as pywebostv use).
        await this.request('ssap://com.webos.service.tv.systemkeys/handleKey', { key });
        return;
      }
      case 'volume_set': {
        const target = Number(params.value);
        const cur = this.state.volume ?? 0;
        const steps = target - cur;
        await this.request('ssap://audio/setVolume', { volume: target });
        void steps;
        this.state.volume = target;
        return;
      }
      case 'volume_up':
        await this.request('ssap://audio/volumeUp');
        return;
      case 'volume_down':
        await this.request('ssap://audio/volumeDown');
        return;
      case 'mute_toggle':
        await this.request('ssap://audio/setMute', { mute: !this.state.muted });
        this.state.muted = !this.state.muted;
        return;
      case 'toggle_power':
        await this.action(this.state.power ? 'power_off' : 'power_on', {});
        return;
      case 'channel_set':
        await this.request('ssap://tv/openChannel', { channelNumber: String(params.value) });
        this.state.channel = String(params.value);
        return;
      case 'input_set':
        await this.request('ssap://tv/switchInput', { inputId: String(params.value) });
        this.state.input = String(params.value);
        return;
      default:
        throw new Error(`LG TV does not support "${name}"`);
    }
  }

  private connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`ws://${this.host}:${this.port}`, { rejectUnauthorized: false });
    this.ws = ws;

    ws.on('open', () => {
      // Minimal SSAP register payload: enough for pairing + control URIs.
      const payload: Record<string, unknown> = {
        forcePairing: false,
        pairingType: 'PROMPT_AUTH',
        manifest: {
          manifestVersion: 1,
          appVersion: '1.1',
          signed: {
            created: '20140509',
            appId: 'com.homehub.control',
            vendorId: 'com.homehub',
            localizedStrings: [],
            permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_URI', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_TV_SCREEN', 'CONTROL_VOLUME', 'CONTROL_TV_POWER', 'READ_POWER_STATE'],
            signatures: [],
          },
        },
        ...(this.opts.clientKey ? { 'client-key': String(this.opts.clientKey) } : {}),
      };
      ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'registered' || msg.id === 'register_0') {
          this.state.power = true;
          if (msg.payload?.['client-key'] && this.opts.onClientKey) {
            this.opts.onClientKey(msg.payload['client-key']);
          }
        }
        if (this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.type === 'error') reject(new Error(`${msg.error || 'LG error'}: ${msg.payload?.reason || ''}`));
          else resolve(msg.payload);
        }
      } catch {
        /* ignore */
      }
    });

    ws.on('error', () => {
      /* offline; poll will retry */
    });
    ws.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
      this.pending.clear();
    });
  }

  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private async request(uri: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await assertPrivateHost(this.host);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      await new Promise((r) => setTimeout(r, 800));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('LG TV is unreachable (check it is on, and "LG Connect Apps" is enabled)');
    }
    const id = `req_${++this.requestId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, type: 'request', uri, payload }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LG request timed out: ${uri}`));
        }
      }, 5000);
    });
  }
}

const LG_KEYS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'EXIT', 'MENU', 'SOURCE', 'PLAY', 'PAUSE', 'STOP', 'REWIND', 'FASTFORWARD', 'RED', 'GREEN', 'YELLOW', 'BLUE', 'MUTE', 'VOL_UP', 'VOL_DOWN', 'CH_UP', 'CH_DOWN'];
