import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AndroidRemote, Certificate } from '@kud/androidtv-remote';
import { ActionDef, DeviceDriver, DeviceState } from '../types';
import { loadAndroidTvRemote } from '../androidtv';
import { assertPrivateHost, wakeOnLan, withTimeout } from '../util';

const execFileAsync = promisify(execFile);

const ACTIONS: ActionDef[] = [
  { name: 'power_toggle', label: 'Power' },
  { name: 'remote_key', label: 'Remote key', params: [{ name: 'key', type: 'enum', options: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'MENU', 'SETTINGS', 'PLAY', 'PAUSE', 'PLAY_PAUSE', 'STOP', 'REWIND', 'FAST_FORWARD', 'CHANNEL_UP', 'CHANNEL_DOWN', 'MUTE', 'VOLUME_UP', 'VOLUME_DOWN', 'SOURCE', 'HDMI_1', 'HDMI_2', 'HDMI_3', 'HDMI_4'] }] },
  { name: 'launch_app', label: 'Open streaming app', params: [{ name: 'app', type: 'enum', options: ['netflix', 'prime_video', 'hotstar', 'youtube'] }] },
];

const APP_LINKS: Record<string, string> = {
  netflix: 'market://launch?id=com.netflix.ninja',
  prime_video: 'market://launch?id=com.amazon.amazonvideo.livingroom',
  hotstar: 'market://launch?id=in.startv.hotstar',
  youtube: 'market://launch?id=com.google.android.youtube.tv',
};

const KEY_NAMES: Record<string, string> = {
  UP: 'KEYCODE_DPAD_UP',
  DOWN: 'KEYCODE_DPAD_DOWN',
  LEFT: 'KEYCODE_DPAD_LEFT',
  RIGHT: 'KEYCODE_DPAD_RIGHT',
  ENTER: 'KEYCODE_DPAD_CENTER',
  BACK: 'KEYCODE_BACK',
  HOME: 'KEYCODE_HOME',
  MENU: 'KEYCODE_MENU',
  SETTINGS: 'KEYCODE_SETTINGS',
  PLAY: 'KEYCODE_MEDIA_PLAY',
  PAUSE: 'KEYCODE_MEDIA_PAUSE',
  PLAY_PAUSE: 'KEYCODE_MEDIA_PLAY_PAUSE',
  STOP: 'KEYCODE_MEDIA_STOP',
  REWIND: 'KEYCODE_MEDIA_REWIND',
  FAST_FORWARD: 'KEYCODE_MEDIA_FAST_FORWARD',
  CHANNEL_UP: 'KEYCODE_CHANNEL_UP',
  CHANNEL_DOWN: 'KEYCODE_CHANNEL_DOWN',
  SOURCE: 'KEYCODE_TV_INPUT',
  HDMI_1: 'KEYCODE_TV_INPUT_HDMI_1',
  HDMI_2: 'KEYCODE_TV_INPUT_HDMI_2',
  HDMI_3: 'KEYCODE_TV_INPUT_HDMI_3',
  HDMI_4: 'KEYCODE_TV_INPUT_HDMI_4',
  MUTE: 'KEYCODE_MUTE',
  VOLUME_UP: 'KEYCODE_VOLUME_UP',
  VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN',
};

async function findNeighborMac(host: string): Promise<string | undefined> {
  const args = process.platform === 'win32' ? ['-a', host] : ['-n', host];
  const { stdout } = await execFileAsync('arp', args, {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  return stdout.match(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i)?.[0];
}

export class SonyBraviaDriver implements DeviceDriver {
  readonly label = 'Sony BRAVIA / Android TV';
  readonly actions = ACTIONS;

  private remote?: AndroidRemote;
  private startTask?: Promise<void>;
  private state: DeviceState = {};
  private ready = false;

  constructor(
    private readonly host: string,
    private readonly certificate: Certificate,
  ) {}

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startTask) return this.startTask;
    const task = this.connect();
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = undefined;
    }
  }

  private async connect(): Promise<void> {
    await assertPrivateHost(this.host);
    this.remote?.stop();
    this.remote = undefined;
    this.ready = false;
    const { createAndroidRemote } = await loadAndroidTvRemote();
    const remote = createAndroidRemote(this.host, {
      cert: this.certificate,
      manufacturer: 'HomeHub',
      model: 'HomeHub',
    });
    this.remote = remote;
    const isCurrentRemote = () => this.remote === remote;
    const readiness = new Promise<void>((resolve, reject) => {
      remote.once('ready', resolve);
      remote.once('error', reject);
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error : new Error('Sony TV connection failed'),
      }),
    );
    remote.on('ready', () => {
      if (!isCurrentRemote()) return;
      this.ready = true;
      delete this.state.lastError;
    });
    remote.on('powered', (powered) => {
      if (isCurrentRemote()) this.state.power = powered;
    });
    remote.on('volume', (volume) => {
      if (!isCurrentRemote()) return;
      this.state.volume = volume.maximum > 0 ? Math.round((volume.level / volume.maximum) * 100) : 0;
      this.state.muted = volume.muted;
    });
    remote.on('current_app', (app) => {
      if (isCurrentRemote()) this.state.app = app;
    });
    remote.on('error', (error) => {
      if (!isCurrentRemote()) return;
      this.ready = false;
      this.state.lastError = error.message;
    });
    remote.on('unpaired', () => {
      if (!isCurrentRemote()) return;
      this.ready = false;
      this.state.lastError = 'The TV revoked HomeHub pairing. Pair it again from discovery.';
    });

    try {
      const started = await withTimeout(remote.start(), 15_000, 'Sony TV connection');
      if (!started) throw new Error('Sony TV did not accept the remote connection');
      const result = await withTimeout(readiness, 10_000, 'Sony TV ready handshake');
      if (!result.ok) throw result.error;
      this.ready = true;
      delete this.state.lastError;
    } catch (error) {
      remote.stop();
      if (isCurrentRemote()) this.remote = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.remote?.stop();
    this.remote = undefined;
  }

  async poll(): Promise<DeviceState | null> {
    if (!this.ready) {
      try {
        await this.start();
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    }
    return this.ready ? { ...this.state } : null;
  }

  async action(name: string, params: Record<string, unknown>): Promise<void> {
    if (name === 'power_toggle' && !this.ready && this.state.power === false) {
      await this.wakeFromStandby();
      return;
    }
    if (!this.remote || !this.ready) await this.start();
    const remote = this.remote;
    if (!remote || !this.ready) {
      throw new Error('Sony TV remote could not reconnect. Check the TV power and network, then retry.');
    }
    const { RemoteDirection, RemoteKeyCode } = await loadAndroidTvRemote();
    if (name === 'power_toggle') {
      remote.sendPower();
      return;
    }
    if (name === 'remote_key') {
      const keyName = KEY_NAMES[String(params.key ?? '').toUpperCase()];
      const keyCode = keyName ? RemoteKeyCode[keyName] : undefined;
      if (keyCode === undefined) throw new Error(`Unsupported Sony TV key: ${String(params.key)}`);
      remote.sendKey(keyCode, RemoteDirection.SHORT);
      return;
    }
    if (name === 'launch_app') {
      const app = String(params.app ?? '').toLowerCase();
      const appLink = APP_LINKS[app];
      if (!appLink) throw new Error(`Unsupported Sony TV app: ${String(params.app)}`);
      remote.sendAppLink(appLink);
      return;
    }
    throw new Error(`Sony TV does not support "${name}"`);
  }

  private async wakeFromStandby(): Promise<void> {
    await assertPrivateHost(this.host);
    const mac = await findNeighborMac(this.host);
    if (!mac) {
      throw new Error(
        'The TV is in standby and its MAC address is not in the hub computer local network cache. Enable Networked Standby/Remote Start on the TV, wake it once with its physical remote, then retry.',
      );
    }
    await wakeOnLan(mac);
  }
}
