/**
 * Samsung TV driver.
 *
 * Talks to the TV's built-in WebSocket remote-control API (port 8001 unencrypted /
 * 8002 encrypted on newer models). Requires "Mobile Device" / remote access enabled
 * on the TV. On first connect the TV shows an "Allow" / PIN prompt; pass the PIN via
 * options.pin if shown.
 */
import WebSocket from 'ws';
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { assertPrivateHost, http, wakeOnLan, withTimeout } from '../util';

const KEY_MAP: Record<string, string> = {
  UP: 'KEY_UP',
  DOWN: 'KEY_DOWN',
  LEFT: 'KEY_LEFT',
  RIGHT: 'KEY_RIGHT',
  ENTER: 'KEY_ENTER',
  BACK: 'KEY_RETURN',
  HOME: 'KEY_HOME',
  EXIT: 'KEY_EXIT',
  PLAY: 'KEY_PLAY',
  PAUSE: 'KEY_PAUSE',
  STOP: 'KEY_STOP',
  SOURCE: 'KEY_SOURCE',
  MENU: 'KEY_MENU',
  MUTE: 'KEY_MUTE',
  VOL_UP: 'KEY_VOLUP',
  VOL_DOWN: 'KEY_VOLDOWN',
  CH_UP: 'KEY_CHUP',
  CH_DOWN: 'KEY_CHDOWN',
  POWER: 'KEY_POWER',
};

export class SamsungTvDriver implements DeviceDriver {
  readonly label = 'Samsung TV';
  readonly actions: ActionDef[] = [
    { name: 'power_on', label: 'Power on (Wake-on-LAN)' },
    { name: 'power_off', label: 'Power off' },
    { name: 'remote_key', label: 'Remote key', params: [{ name: 'key', type: 'enum', options: Object.keys(KEY_MAP) }] },
    { name: 'volume_set', label: 'Set volume', params: [{ name: 'value', type: 'number', min: 0, max: 100 }] },
    { name: 'mute_toggle', label: 'Mute' },
    { name: 'volume_up', label: 'Volume up' },
    { name: 'volume_down', label: 'Volume down' },
    { name: 'channel_set', label: 'Set channel', params: [{ name: 'value', type: 'string' }] },
    { name: 'input_set', label: 'Set input', params: [{ name: 'value', type: 'string' }] },
  ];

  private state: DeviceState = {};
  private ws?: WebSocket;

  constructor(
    private host: string,
    private opts: Record<string, any>,
  ) {}

  private get port(): number {
    return Number(this.opts.port ?? 8001);
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
      // The TV exposes its power state via a REST call on the remote-control API.
      const res = await http(`http://${this.host}:${this.port}/api/v2/channels/samsung.remote.control/state`, {
        timeoutMs: 3000,
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 200 && res.json) {
        this.state.power = res.json?.power === 'on';
        if (res.json?.volume !== undefined) this.state.volume = res.json.volume;
        if (res.json?.mute !== undefined) this.state.muted = !!res.json.mute;
        if (res.json?.channel?.channelNumber) this.state.channel = String(res.json.channel.channelNumber);
        this.ensureConnected();
        return { ...this.state };
      }
      return null;
    } catch {
      return null;
    }
  }

  async action(name: string, params: Record<string, any>): Promise<void> {
    switch (name) {
      case 'power_on':
        await wakeOnLan(this.opts.mac);
        return;
      case 'power_off':
        await this.sendKey('KEY_POWER');
        this.state.power = false;
        return;
      case 'remote_key': {
        const key = KEY_MAP[String(params.key).toUpperCase()];
        if (!key) throw new Error(`Unknown key ${params.key}`);
        await this.sendKey(key);
        return;
      }
      case 'volume_set':
        await this.sendKey('KEY_VOLUP', Number(params.value) - (this.state.volume ?? 0));
        return;
      case 'volume_up':
        await this.sendKey('KEY_VOLUP');
        return;
      case 'volume_down':
        await this.sendKey('KEY_VOLDOWN');
        return;
      case 'mute_toggle':
        await this.sendKey('KEY_MUTE');
        return;
      case 'channel_set':
        for (const ch of String(params.value)) await this.sendKey(`KEY_${ch}`);
        return;
      case 'input_set':
        // Samsung exposes input switching by name; fall back to SOURCE cycling.
        await this.sendKey('KEY_SOURCE');
        return;
      default:
        throw new Error(`Samsung TV does not support "${name}"`);
    }
  }

  private ensureConnected(): void {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
  }

  private connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const app = Buffer.from('HomeHub/1.0').toString('base64');
    const url = `ws://${this.host}:${this.port}/api/v2/channels/samsung.remote.control?name=${app}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    this.ws = ws;
    let registered = false;

    ws.on('open', () => {
      const register = {
        method: 'ms.channel.connect',
        params: {
          'client-name': 'HomeHub',
          'client-app-name': 'HomeHub',
          ...(this.opts.pin ? { auth: String(this.opts.pin) } : {}),
        },
      };
      ws.send(JSON.stringify(register));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.event === 'ms.channel.connect' || msg.data?.event === 'ms.channel.connect') {
          registered = true;
          this.state.power = true;
        }
        if (msg.event === 'ms.channel.unauthorized' || msg.data?.event === 'ms.channel.unauthorized') {
          this.state.lastAuthError = 'TV rejected the pairing. Remove the TV from the TV settings and retry.';
        }
        void registered;
      } catch {
        /* ignore non-JSON frames */
      }
    });

    ws.on('error', () => {
      /* device offline; polling will retry */
    });
  }

  private async sendKey(key: string, times = 1): Promise<void> {
    await assertPrivateHost(this.host);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const ws = this.ws!;
          ws.once('open', () => resolve());
          ws.once('error', reject);
          setTimeout(() => resolve(), 2500); // resolve anyway; send below will fail if not open
        }),
        4000,
        'TV connect',
      ).catch(() => {});
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('TV is unreachable (is it on the same network, with remote access enabled?)');
    }
    for (let i = 0; i < Math.max(1, times); i++) {
      ws.send(
        JSON.stringify({
          method: 'ms.remote.control',
          params: { Cmd: 'Click', Data: key, Option: false, Type: 'irkeydown' },
        }),
      );
      if (times > 1) await new Promise((r) => setTimeout(r, 120));
    }
  }
}
