/** Device registry: owns drivers, state cache, polling and event fan-out. */
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { ActionDef, DeviceConfig, DeviceDriver, DeviceInfo, DeviceState, HubEvent } from './types';
import { createDriver } from './drivers';

interface Entry {
  config: DeviceConfig;
  driver: DeviceDriver;
  state: DeviceState;
  online: boolean;
  timer?: NodeJS.Timeout;
  lastSeenMs: number;
  driverActions: ActionDef[];
  polling?: Promise<void>;
  actionQueue: Promise<void>;
  stopped: boolean;
  pendingActions: number;
  lastPollError?: string;
}

export class Registry extends EventEmitter {
  private entries = new Map<string, Entry>();

  constructor(private devices: DeviceConfig[]) {
    super();
  }

  async start(): Promise<void> {
    for (const cfg of this.devices) {
      await this.addDevice(cfg, false);
    }

    function sameState(left: DeviceState, right: DeviceState): boolean {
      return isDeepStrictEqual(left, right);
    }
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      if (entry.timer) clearInterval(entry.timer);
      await entry.actionQueue;
      await entry.polling;
      await entry.driver.stop();
    }
    this.entries.clear();
  }

  async addDevice(cfg: DeviceConfig, broadcast = true): Promise<DeviceInfo> {
    if (this.entries.has(cfg.id)) throw new Error(`Device id already exists: ${cfg.id}`);
    const driver = createDriver(cfg);
    const entry: Entry = {
      config: cfg,
      driver,
      state: {},
      online: false,
      lastSeenMs: 0,
      driverActions: driver.actions,
      actionQueue: Promise.resolve(),
      stopped: false,
      pendingActions: 0,
    };
    this.entries.set(cfg.id, entry);
    try {
      await driver.start();
    } catch (err) {
      // A failing start must not kill the hub; mark offline and let polling retry.
      this.log(`driver start failed for ${cfg.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const pollMs = cfg.pollMs ?? 10_000;
    entry.timer = setInterval(() => {
      if (!entry.polling && entry.pendingActions === 0) void this.pollOne(cfg.id);
    }, pollMs);
    entry.timer.unref?.();
    void this.pollOne(cfg.id);
    const info = this.info(cfg.id);
    if (broadcast) this.emitEvent({ type: 'device_added', device: info, ts: Date.now() });
    return info;
  }

  async removeDevice(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stopped = true;
    if (entry.timer) clearInterval(entry.timer);
    await entry.actionQueue;
    await entry.polling;
    await entry.driver.stop();
    this.entries.delete(id);
    this.emitEvent({ type: 'device_removed', device: this.infoFromEntry(entry), ts: Date.now() });
  }

  list(): DeviceInfo[] {
    return [...this.entries.keys()].map((id) => this.info(id));
  }

  get(id: string): DeviceInfo {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown device: ${id}`);
    return this.info(id);
  }

  rooms(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.config.room))].sort();
  }

  async action(id: string, name: string, params: Record<string, any> = {}): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown device: ${id}`);
    entry.pendingActions++;
    const operation = entry.actionQueue.then(async () => {
      if (entry.stopped) throw new Error(`Device "${id}" is stopping`);
      await entry.polling;
      await entry.driver.action(name, params);
      await this.pollOne(id, true);
    });
    entry.actionQueue = operation.catch(() => {}).finally(() => {
      entry.pendingActions--;
    });
    await operation;
  }

  private pollOne(id: string, force = false): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.stopped || (entry.pendingActions > 0 && !force)) return Promise.resolve();
    if (entry.polling) return entry.polling;

    const polling = this.performPoll(id, entry).finally(() => {
      if (entry.polling === polling) entry.polling = undefined;
    });
    entry.polling = polling;
    return polling;
  }

  private async performPoll(id: string, entry: Entry): Promise<void> {
    let state: DeviceState | null = null;
    try {
      state = await entry.driver.poll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== entry.lastPollError) this.log(`driver poll failed for ${id}: ${message}`);
      entry.lastPollError = message;
    }
    if (entry.stopped) return;
    if (state !== null) entry.lastPollError = undefined;
    const online = state !== null;
    const changed = online !== entry.online || (state !== null && !sameState(state, entry.state));
    entry.online = online;
    if (state) {
      entry.state = state;
      entry.lastSeenMs = Date.now();
    }
    if (changed) this.emitEvent({ type: 'state', devices: [this.info(id)], ts: Date.now() });
  }

  private info(id: string): DeviceInfo {
    const e = this.entries.get(id)!;
    return this.infoFromEntry(e);
  }

  private infoFromEntry(e: Entry): DeviceInfo {
    const { options, ...rest } = e.config;
    return {
      ...rest,
      online: e.online,
      state: e.state,
      actions: e.driverActions ?? [],
      driverLabel: e.driver.label,
      lastSeenMs: e.lastSeenMs,
    };
  }

  private log(message: string): void {
    this.emitEvent({ type: 'log', message, ts: Date.now() });
  }

  private emitEvent(evt: HubEvent): void {
    this.emit('event', evt);
  }
}

function sameState(left: DeviceState, right: DeviceState): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(left[key], right[key]));
}
