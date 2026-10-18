// End-to-end check of the hub: REST auth, device list, actions, WS live push.
import WebSocket from 'ws';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../dist/server.js');
const { Registry } = require('../dist/registry.js');
const { SonyBraviaDriver } = require('../dist/drivers/sony-bravia.js');
const cfg = {
  port: 0,
  bind: '127.0.0.1',
  token: 'integration-test-token-0123456789',
  homeName: 'Integration Test Home',
  corsOrigins: ['null'],
  devices: [
    { id: 'demo-tv', name: 'Demo TV', room: 'Living Room', class: 'tv', driver: 'mock', options: { flavor: 'tv' } },
    { id: 'demo-ac', name: 'Demo AC', room: 'Bedroom', class: 'ac', driver: 'mock', options: { flavor: 'ac' } },
    { id: 'demo-washer', name: 'Demo Washer', room: 'Utility', class: 'washer', driver: 'mock', options: { flavor: 'washer' } },
    { id: 'demo-light', name: 'Demo Light', room: 'Living Room', class: 'light', driver: 'mock', options: { flavor: 'light' } },
  ],
  discovery: { enabled: false, ssdp: false, mdns: false, probeHosts: [] },
};
const registry = new Registry(cfg.devices);
await registry.start();
await new Promise((resolve) => setTimeout(resolve, 25));
const hub = createServer(cfg, registry);
const listening = once(hub.server, 'listening');
hub.server.listen(0, '127.0.0.1');
await listening;
const port = hub.server.address().port;
const base = `http://127.0.0.1:${port}`;
const token = cfg.token;
let failures = 0;

const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const api = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// 0. Sony remote-key dispatch without requiring a physical TV.
{
  const { RemoteDirection, RemoteKeyCode } = await import('@kud/androidtv-remote');
  const sony = new SonyBraviaDriver('192.168.1.10', { key: '', cert: '' });
  const sentKeys = [];
  const launchedLinks = [];
  let powerPresses = 0;
  sony.remote = {
    sendKey: (keyCode, direction) => sentKeys.push({ keyCode, direction }),
    sendAppLink: (link) => launchedLinks.push(link),
    sendPower: () => { powerPresses++; },
  };
  sony.ready = true;
  sony.state = { power: true };
  await sony.action('power_toggle', {});
  await sony.action('remote_key', { key: 'UP' });
  await sony.action('remote_key', { key: 'ENTER' });
  await sony.action('remote_key', { key: 'HDMI_2' });
  check('Sony remote keys dispatch to Android TV keycodes', sentKeys.length === 3
    && sentKeys[0].keyCode === RemoteKeyCode.KEYCODE_DPAD_UP
    && sentKeys[1].keyCode === RemoteKeyCode.KEYCODE_DPAD_CENTER
    && sentKeys[2].keyCode === RemoteKeyCode.KEYCODE_TV_INPUT_HDMI_2
    && sentKeys.every((key) => key.direction === RemoteDirection.SHORT));
  check('Sony power toggle sends the command without fabricating power state', powerPresses === 1 && sony.state.power === true);
  const reconnectingSony = new SonyBraviaDriver('192.168.1.10', { key: '', cert: '' });
  let reconnects = 0;
  reconnectingSony.start = async () => {
    reconnects++;
    reconnectingSony.ready = true;
  };
  reconnectingSony.state = { power: true };
  const reconnectedState = await reconnectingSony.poll();
  check('Sony polling reconnects a dropped remote session', reconnects === 1 && reconnectedState?.power === true);
  const standbySony = new SonyBraviaDriver('192.168.1.10', { key: '', cert: '' });
  let wakeRequests = 0;
  standbySony.state = { power: false };
  standbySony.wakeFromStandby = async () => { wakeRequests++; };
  await standbySony.action('power_toggle', {});
  check('Sony power-on uses standby wake when the remote session is unavailable', wakeRequests === 1);
  await sony.action('launch_app', { app: 'netflix' });
  await sony.action('launch_app', { app: 'prime_video' });
  await sony.action('launch_app', { app: 'hotstar' });
  await sony.action('launch_app', { app: 'youtube' });
  check('Sony streaming apps use Android TV package launch links', [
    ['com.netflix.ninja', launchedLinks[0]],
    ['com.amazon.amazonvideo.livingroom', launchedLinks[1]],
    ['in.startv.hotstar', launchedLinks[2]],
    ['com.google.android.youtube.tv', launchedLinks[3]],
  ].every(([packageName, link]) => link === `market://launch?id=${packageName}`));
  let unsupportedAppRejected = false;
  try {
    await sony.action('launch_app', { app: 'unknown' });
  } catch {
    unsupportedAppRejected = true;
  }
  check('Sony rejects unsupported streaming app actions', unsupportedAppRejected);
}

// 1. ping (no auth)
{
  const res = await fetch(base + '/api/ping');
  check('ping works unauthenticated', res.status === 200);
}

// 2. auth rejection
{
  const res = await fetch(base + '/api/devices');
  check('devices without token -> 401', res.status === 401);
  const res2 = await fetch(base + '/api/devices?token=wrong');
  check('devices with wrong token -> 401', res2.status === 401);
  const nullOrigin = await fetch(base + '/api/devices', {
    headers: { authorization: 'Bearer ' + token, origin: 'null' },
  });
  check('Electron null origin is allowed with auth', nullOrigin.status === 200 && nullOrigin.headers.get('access-control-allow-origin') === 'null');
  const unexpectedOrigin = await fetch(base + '/api/devices', {
    headers: { authorization: 'Bearer ' + token, origin: 'https://untrusted.invalid' },
  });
  check('unconfigured browser origin is rejected', unexpectedOrigin.status === 403);
}

// 3. device list
let devices;
{
  const { status, json } = await api('/api/devices');
  devices = json.devices;
  check('device list -> 200 with 4 isolated test devices', status === 200 && devices.length === 4, `got ${devices.length}`);
  check('rooms present', json.rooms.includes('Bedroom') && json.rooms.includes('Living Room'), json.rooms.join(','));
  const ac = devices.find((d) => d.class === 'ac');
  check('AC device has temperature actions', ac?.actions.some((a) => a.name === 'temperature_set'));
  check('washer reports phase state', devices.find((d) => d.class === 'washer')?.state.phase !== undefined);
}

// 4. single device
{
  const { status, json } = await api('/api/devices/demo-tv');
  check('get single device', status === 200 && json.id === 'demo-tv');
}

// 5. discovered-device registration validates scan candidates
{
  const malformed = await api('/api/devices/discovered', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  check('discovered-device add rejects missing discovery id', malformed.status === 400);

  const expired = await api('/api/devices/discovered', {
    method: 'POST',
    body: JSON.stringify({ discoveryId: 'not-from-a-scan' }),
  });
  check('discovered-device add rejects unknown scan result', expired.status === 404);

  const missingSonyCandidate = await api('/api/devices/discovered/pair', {
    method: 'POST',
    body: JSON.stringify({ discoveryId: 'not-from-a-scan' }),
  });
  check('Sony pairing rejects unknown scan result', missingSonyCandidate.status === 404);

  const invalidPairCode = await api('/api/devices/discovered/pair/confirm', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'not-a-session', code: 'invalid' }),
  });
  check('Sony pairing rejects an invalid pairing code', invalidPairCode.status === 400);

  const hexadecimalPairCode = await api('/api/devices/discovered/pair/confirm', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'not-a-session', code: 'A1B2C3' }),
  });
  check('Sony pairing accepts hexadecimal letters in the code', hexadecimalPairCode.status === 404);

  const missingPairSession = await api('/api/devices/discovered/pair/cancel', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  check('Sony pairing cancellation validates the session id', missingPairSession.status === 400);
}

// 6. actions over REST + state reflection
{
  const r1 = await api('/api/devices/demo-ac/action', { method: 'POST', body: JSON.stringify({ action: 'temperature_set', params: { value: 21 } }) });
  check('AC temperature_set 21', r1.status === 200 && r1.json.device.state.targetTemperature === 21, `temp=${r1.json?.device?.state?.targetTemperature}`);

  const r2 = await api('/api/devices/demo-ac/action', { method: 'POST', body: JSON.stringify({ action: 'mode_set', params: { value: 'heat' } }) });
  check('AC mode_set heat', r2.status === 200 && r2.json.device.state.mode === 'heat');

  const r3 = await api('/api/devices/demo-light/action', { method: 'POST', body: JSON.stringify({ action: 'brightness_set', params: { value: 35 } }) });
  check('light brightness 35', r3.status === 200 && r3.json.device.state.brightness === 35);

  const r4 = await api('/api/devices/demo-washer/action', { method: 'POST', body: JSON.stringify({ action: 'power_on' }) });
  check('washer start -> running', r4.status === 200 && r4.json.device.state.running === true, JSON.stringify(r4.json?.device?.state));

  const r5 = await api('/api/devices/demo-tv/action', { method: 'POST', body: JSON.stringify({ action: 'remote_key', params: { key: 'ENTER' } }) });
  check('TV remote ENTER', r5.status === 200);

  const r6 = await api('/api/devices/demo-tv/action', { method: 'POST', body: JSON.stringify({ action: 'bogus_action' }) });
  check('unknown action -> 400', r6.status === 400);

  const r7 = await api('/api/devices/nope/action', { method: 'POST', body: JSON.stringify({ action: 'x' }) });
  check('unknown device -> 400', r7.status === 400);
}

// 7. WebSocket: hello snapshot + live state push after action
{
  const currentVolume = devices.find((device) => device.id === 'demo-tv')?.state.volume;
  const targetVolume = currentVolume === 42 ? 43 : 42;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['homehub', `homehub-auth.${token}`], {
      headers: { origin: 'null' },
    });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS: no state push within 6s'));
    }, 6000);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'hello') {
        check('WS hello carries devices', msg.devices.length === devices.length);
        // Trigger a change the hub should broadcast.
        void fetch(`${base}/api/devices/demo-tv/action`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'volume_set', params: { value: targetVolume } }),
        }).then((response) => {
          if (!response.ok) throw new Error(`TV action returned HTTP ${response.status}`);
        }).catch(reject);
      }
      if (msg.type === 'state' && msg.devices?.some((device) => device.id === 'demo-tv' && device.state.volume === targetVolume)) {
        clearTimeout(timer);
        check('WS live state push after action', true);
        ws.close();
        resolve();
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    check('WS live state push after action', false, err.message);
  });
}

// 8. WebSocket rejects bad token
{
  const queryAuthAccepted = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 2000);
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
  });
  check('WS query-token auth rejected', !queryAuthAccepted);

  const connectWithBadToken = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['homehub', 'homehub-auth.bogus']);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 2000);
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
  });
  const ok = await connectWithBadToken();
  check('WS with bad token refused', !ok);
}

await hub.close();
await registry.stop();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
