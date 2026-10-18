/** HTTP + WebSocket server exposing the hub API to the mobile app. */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AndroidRemote, Certificate } from '@kud/androidtv-remote';
import { HubConfig, persistConfig } from './config';
import { Registry } from './registry';
import { DeviceClass, DeviceConfig, DiscoveryResult } from './types';
import { runDiscovery } from './discovery';
import { assertPrivateHost, withTimeout } from './util';
import { loadAndroidTvRemote } from './androidtv';

export interface HubServer {
  server: http.Server;
  close(): Promise<void>;
}

interface SonyPairingSession {
  id: string;
  candidate: DiscoveryResult;
  remote: AndroidRemote;
  started: Promise<{ ok: boolean; error?: string }>;
  timer: NodeJS.Timeout;
  busy: boolean;
}

interface WsRequest {
  type: 'ping' | 'action';
  requestId?: string;
  id?: string;
  action?: string;
  params?: Record<string, unknown>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_WS_CLIENTS = 64;
const MAX_WS_BUFFERED_BYTES = 256 * 1024;
const WS_HEARTBEAT_MS = 30_000;

export function createServer(config: HubConfig, registry: Registry): HubServer {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (res.destroyed || res.writableEnded) return;
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
        return;
      }
      console.error('Hub request failed:', err);
      send(res, 500, { error: 'Internal server error' });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has('homehub') ? 'homehub' : false,
  });
  const clients = new Set<WebSocket>();
  let discoveryInFlight: Promise<DiscoveryResult[]> | null = null;
  let latestDiscovery: DiscoveryResult[] = [];
  const addingCandidates = new Set<string>();
  const sonyPairingSessions = new Map<string, SonyPairingSession>();
  const sonyPairingCandidates = new Set<string>();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const target = parseRequestTarget(req.url);
    if (req.method !== 'GET' || !target || target.pathname !== '/ws' || target.search) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, 'Origin not allowed');
      return;
    }
    if (clients.size >= MAX_WS_CLIENTS) {
      rejectUpgrade(socket, 503, 'WebSocket capacity reached');
      return;
    }
    if (!isAuthorized(req.headers.authorization, wsProtocolToken(req.headers['sec-websocket-protocol']), config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    let alive = true;
    let messagesThisWindow = 0;
    let windowStartedAt = Date.now();
    sendSocket(ws, { type: 'hello', homeName: config.homeName, devices: registry.list(), ts: Date.now() });
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('error', (err) => {
      console.warn('WebSocket client error:', err.message);
      clients.delete(ws);
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      void (async () => {
        let msg: WsRequest | null = null;
        try {
          const parsed: unknown = JSON.parse(String(data));
          if (!isWsRequest(parsed)) throw new HttpError(400, 'Invalid WebSocket message');
          msg = parsed;
          const now = Date.now();
          if (now - windowStartedAt >= 1000) {
            windowStartedAt = now;
            messagesThisWindow = 0;
          }
          messagesThisWindow++;
          if (messagesThisWindow > 30) throw new HttpError(429, 'WebSocket message rate exceeded');

          if (msg.type === 'action') {
            if (!msg.id || !msg.action) throw new HttpError(400, 'Action messages require id and action');
            await registry.action(msg.id, msg.action, msg.params ?? {});
            sendSocket(ws, { type: 'actionResult', requestId: msg.requestId, ok: true, ts: Date.now() });
          } else if (msg.type === 'ping') {
            sendSocket(ws, { type: 'pong', requestId: msg.requestId, ts: Date.now() });
          }
        } catch (err) {
          sendSocket(ws, {
            type: 'actionResult',
            requestId: msg?.requestId,
            ok: false,
            error: err instanceof Error ? err.message : 'Invalid WebSocket message',
            ts: Date.now(),
          });
        }
      })();
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        clients.delete(ws);
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, WS_HEARTBEAT_MS);
    heartbeat.unref?.();
    ws.once('close', () => clearInterval(heartbeat));
  });

  const onEvent = (evt: unknown) => {
    for (const ws of clients) sendSocket(ws, evt);
  };
  registry.on('event', onEvent);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = parseRequestTarget(req.url);
    if (!parsed) throw new HttpError(400, 'Invalid request target');
    const path = parsed.pathname;
    const method = req.method || 'GET';
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) {
      send(res, 403, { error: 'Origin not allowed' });
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/api/ping') {
      send(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    if (!isAuthorized(req.headers.authorization, undefined, config.token)) {
      send(res, 401, { error: 'Missing or invalid token. Set the same token in the app as in config.json.' });
      return;
    }

    if (path === '/api/status' && method === 'GET') {
      send(res, 200, { ok: true, homeName: config.homeName, devices: registry.list().length, ts: Date.now() });
      return;
    }

    if (path === '/api/devices' && method === 'GET') {
      send(res, 200, { homeName: config.homeName, rooms: registry.rooms(), devices: registry.list() });
      return;
    }

    const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
    if (deviceMatch && method === 'GET') {
      send(res, 200, registry.get(decodePathSegment(deviceMatch[1])));
      return;
    }

    const actionMatch = path.match(/^\/api\/devices\/([^/]+)\/action$/);
    if (actionMatch && method === 'POST') {
      const body = await readBody(req);
      if (!isRecord(body)) {
        throw new HttpError(400, 'Body must be a JSON object');
      }
      const { action, params } = body;
      if (typeof action !== 'string' || !/^[\x21-\x7e]{1,100}$/.test(action)) {
        send(res, 400, { error: 'Body must be { "action": "...", "params": {...} }' });
        return;
      }
      if (params !== undefined && !isRecord(params)) throw new HttpError(400, 'params must be a JSON object');
      const id = decodePathSegment(actionMatch[1]);
      try {
        await registry.action(id, action, params ?? {});
        send(res, 200, { ok: true, device: registry.get(id) });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        send(res, 400, { error: err instanceof Error ? err.message : 'Device action failed' });
      }
      return;
    }

    if (path === '/api/discover' && method === 'POST') {
      discoveryInFlight ??= runDiscovery(config.discovery)
        .then((results) => results.map((result) => ({
          ...result,
          ...suggestDevice(result),
          addedDeviceId: config.devices.find((device) =>
            device.host === result.host && device.driver === suggestDevice(result).suggestedDriver)?.id,
        })))
        .finally(() => { discoveryInFlight = null; });
      latestDiscovery = await discoveryInFlight;
      send(res, 200, { found: latestDiscovery, hint: 'Add supported devices from this list. Some devices require one-time pairing.' });
      return;
    }

    if (path === '/api/devices/discovered' && method === 'POST') {
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.discoveryId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(body.discoveryId)) {
        throw new HttpError(400, 'Body must contain a valid discoveryId');
      }
      const candidate = latestDiscovery.find((result) => result.id === body.discoveryId);
      if (!candidate) throw new HttpError(404, 'Discovery result has expired. Scan again and retry.');
      if (addingCandidates.has(candidate.id)) throw new HttpError(409, 'This device is already being added.');
      if (candidate.addedDeviceId) {
        send(res, 200, { device: registry.get(candidate.addedDeviceId) });
        return;
      }
      const suggestion = suggestDevice(candidate);
      if (!suggestion.suggestedDriver || !suggestion.suggestedClass || suggestion.pairingRequired) {
        throw new HttpError(422, 'This device needs an integration or pairing credential that is not available automatically.');
      }
      const alreadyRegistered = config.devices.find((device) =>
        device.host === candidate.host && device.driver === suggestion.suggestedDriver);
      if (alreadyRegistered) {
        candidate.addedDeviceId = alreadyRegistered.id;
        send(res, 200, { device: registry.get(alreadyRegistered.id) });
        return;
      }

      addingCandidates.add(candidate.id);
      try {
        await assertPrivateHost(candidate.host);
        const device = createDiscoveredDevice(candidate, suggestion.suggestedDriver, suggestion.suggestedClass);
        if (device.driver === 'lg-webos') {
          device.options = {
            onClientKey: (clientKey: string) => {
              device.options = { clientKey };
              try {
                persistConfig(config);
              } catch (error) {
                console.error(`Could not save LG TV pairing key for ${device.id}:`, error);
              }
            },
          };
        }
        if (config.devices.some((existing) => existing.id === device.id)) {
          throw new HttpError(409, 'This device is already registered.');
        }
        await registry.addDevice(device);
        config.devices.push(device);
        try {
          persistConfig(config);
        } catch (error) {
          config.devices.pop();
          await registry.removeDevice(device.id);
          throw error;
        }
        candidate.addedDeviceId = device.id;
        send(res, 201, { device: registry.get(device.id) });
      } finally {
        addingCandidates.delete(candidate.id);
      }
      return;
    }

    if (path === '/api/devices/discovered/pair' && method === 'POST') {
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.discoveryId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(body.discoveryId)) {
        throw new HttpError(400, 'Body must contain a valid discoveryId');
      }
      const candidate = latestDiscovery.find((result) => result.id === body.discoveryId);
      if (!candidate) throw new HttpError(404, 'Discovery result has expired. Scan again and retry.');
      if (suggestDevice(candidate).suggestedDriver !== 'sony-bravia') {
        throw new HttpError(422, 'This discovery result is not a supported Sony Android TV.');
      }
      const existing = config.devices.find((device) =>
        device.host === candidate.host && device.driver === 'sony-bravia');
      if (existing) {
        candidate.addedDeviceId = existing.id;
        send(res, 200, { device: registry.get(existing.id) });
        return;
      }
      const activeSession = [...sonyPairingSessions.values()].find(
        (session) => session.candidate.id === candidate.id,
      );
      if (activeSession) {
        send(res, 200, {
          sessionId: activeSession.id,
          name: candidate.name ?? 'Sony BRAVIA TV',
          message: 'Enter the pairing code currently displayed on the TV.',
        });
        return;
      }
      if (sonyPairingCandidates.has(candidate.id)) {
        throw new HttpError(409, 'Pairing is still starting. Wait a moment and try Pair again.');
      }

      sonyPairingCandidates.add(candidate.id);
      let remote: AndroidRemote;
      try {
        await assertPrivateHost(candidate.host);
        const { createAndroidRemote } = await loadAndroidTvRemote();
        remote = createAndroidRemote(candidate.host, {
          manufacturer: 'HomeHub',
          model: 'HomeHub',
        });
      } catch (error) {
        sonyPairingCandidates.delete(candidate.id);
        throw error;
      }
      let resolveSecret!: () => void;
      const secretPrompt = new Promise<void>((resolve, reject) => {
        resolveSecret = resolve;
        remote.once('error', reject);
      });
      remote.once('secret', resolveSecret);
      const started = remote.start().then(
        (ok) => ({ ok, ...(!ok ? { error: 'The TV did not complete Android TV pairing.' } : {}) }),
        (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'TV pairing failed.' }),
      );
      const sessionId = crypto.randomUUID();
      const timer = setTimeout(() => {
        const session = sonyPairingSessions.get(sessionId);
        if (!session) return;
        remote.stop();
        sonyPairingSessions.delete(sessionId);
        sonyPairingCandidates.delete(candidate.id);
      }, 120_000);
      timer.unref?.();
      const session: SonyPairingSession = {
        id: sessionId,
        candidate,
        remote,
        started,
        timer,
        busy: false,
      };
      sonyPairingSessions.set(sessionId, session);

      try {
        const prompt = await withTimeout(Promise.race([
          secretPrompt.then(() => 'secret' as const),
          started.then((result) => result.ok ? 'connected' as const : result.error ?? 'Pairing failed'),
        ]), 15_000, 'Sony TV pairing prompt');
        if (prompt !== 'secret') throw new Error(prompt);
      } catch (error) {
        clearTimeout(timer);
        remote.stop();
        sonyPairingSessions.delete(sessionId);
        sonyPairingCandidates.delete(candidate.id);
        throw new HttpError(422, error instanceof Error
          ? `Could not start pairing with this TV: ${error.message}`
          : 'Could not start pairing with this TV.');
      }
      send(res, 200, {
        sessionId,
        name: candidate.name ?? 'Sony BRAVIA TV',
        message: 'A pairing code should now be visible on the TV.',
      });
      return;
    }

    if (path === '/api/devices/discovered/pair/confirm' && method === 'POST') {
      const body = await readBody(req);
      if (!isRecord(body)
          || typeof body.sessionId !== 'string'
          || typeof body.code !== 'string'
          || !/^[0-9a-f]{6}$/i.test(body.code)) {
        throw new HttpError(400, 'Enter the six-character pairing code shown on the TV (0–9 or A–F).');
      }
      const session = sonyPairingSessions.get(body.sessionId);
      if (!session) throw new HttpError(404, 'Pairing session expired. Start pairing again.');
      if (session.busy) throw new HttpError(409, 'This pairing session is already being completed.');
      session.busy = true;
      try {
        const ready = new Promise<void>((resolve, reject) => {
          session.remote.once('ready', resolve);
          session.remote.once('error', reject);
        });
        if (!session.remote.sendCode(body.code)) {
          throw new HttpError(422, 'The TV pairing session is no longer active. Start pairing again.');
        }
        const [startResult] = await withTimeout(
          Promise.all([session.started, ready]),
          12_000,
          'Sony TV pairing confirmation',
        );
        if (!startResult.ok) throw new HttpError(422, startResult.error ?? 'The TV rejected pairing.');
        const cert: Certificate = session.remote.getCertificate();
        session.remote.stop();
        const storedCert = {
          key: Buffer.from(cert.key, 'utf8').toString('base64'),
          cert: Buffer.from(cert.cert, 'utf8').toString('base64'),
        };

        const suggestion = suggestDevice(session.candidate);
        const device = createDiscoveredDevice(
          session.candidate,
          'sony-bravia',
          suggestion.suggestedClass ?? 'tv',
          { cert: storedCert },
        );
        await registry.addDevice(device);
        config.devices.push(device);
        try {
          persistConfig(config);
        } catch (error) {
          config.devices.pop();
          await registry.removeDevice(device.id);
          throw error;
        }
        session.candidate.addedDeviceId = device.id;
        send(res, 201, { device: registry.get(device.id) });
      } catch (error) {
        session.remote.stop();
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, error instanceof Error
          ? `Could not pair with the TV: ${error.message}`
          : 'Could not pair with the TV. Check the code and try again.');
      } finally {
        clearTimeout(session.timer);
        sonyPairingSessions.delete(session.id);
        sonyPairingCandidates.delete(session.candidate.id);
      }
      return;
    }

    if (path === '/api/devices/discovered/pair/cancel' && method === 'POST') {
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.sessionId !== 'string') {
        throw new HttpError(400, 'Body must contain a pairing session id.');
      }
      const session = sonyPairingSessions.get(body.sessionId);
      if (session) {
        clearTimeout(session.timer);
        session.remote.stop();
        sonyPairingSessions.delete(session.id);
        sonyPairingCandidates.delete(session.candidate.id);
      }
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: `No route: ${method} ${path}` });
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        registry.off('event', onEvent);
        for (const session of sonyPairingSessions.values()) {
          clearTimeout(session.timer);
          session.remote.stop();
        }
        sonyPairingSessions.clear();
        sonyPairingCandidates.clear();
        for (const ws of clients) ws.close(1001, 'Hub shutting down');
        clients.clear();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function suggestDevice(result: DiscoveryResult): Pick<DiscoveryResult, 'suggestedDriver' | 'suggestedClass' | 'pairingRequired' | 'setupNote'> {
  const evidence = [
    result.name ?? '',
    ...result.services,
    ...Object.values(result.raw ?? {}),
  ].join(' ').toLowerCase();
  if (evidence.includes('shelly')) {
    return { suggestedDriver: 'shelly', suggestedClass: 'plug' };
  }
  if (evidence.includes('samsung')) {
    return { suggestedDriver: 'samsung-tv', suggestedClass: 'tv' };
  }
  if (evidence.includes('webos') || evidence.includes('lge') || evidence.includes('lg electronics')) {
    return { suggestedDriver: 'lg-webos', suggestedClass: 'tv' };
  }
  if (evidence.includes('sony') && (evidence.includes('bravia') || evidence.includes('androidtv'))) {
    return { suggestedDriver: 'sony-bravia', suggestedClass: 'tv', pairingRequired: true };
  }
  if (evidence.includes('philips') || evidence.includes('hue')) {
    return { suggestedDriver: 'hue', suggestedClass: 'light', pairingRequired: true };
  }
  return {};
}

function createDiscoveredDevice(
  candidate: DiscoveryResult,
  driver: NonNullable<DiscoveryResult['suggestedDriver']>,
  deviceClass: DeviceClass,
  options?: Record<string, unknown>,
): DeviceConfig {
  const displayName = (candidate.name ?? `${driverLabel(driver)} ${candidate.host}`)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 80) || `${driverLabel(driver)} ${candidate.host}`;
  const safeHost = candidate.host.replace(/[^a-zA-Z0-9.-]/g, '-');
  const id = `auto-${driver}-${safeHost}`.slice(0, 120);
  return {
    id,
    name: displayName,
    room: 'Unassigned',
    class: deviceClass,
    driver,
    host: candidate.host,
    manufacturer: driver === 'shelly' ? 'Shelly' : driver === 'samsung-tv' ? 'Samsung' : driver === 'lg-webos' ? 'LG' : driver === 'sony-bravia' ? 'Sony' : 'Philips',
    ...(options ? { options } : candidate.port && driver === 'samsung-tv' ? { options: { port: candidate.port } } : {}),
  };
}

function driverLabel(driver: NonNullable<DiscoveryResult['suggestedDriver']>): string {
  switch (driver) {
    case 'samsung-tv': return 'Samsung TV';
    case 'lg-webos': return 'LG webOS TV';
    case 'shelly': return 'Shelly';
    case 'hue': return 'Philips Hue';
    case 'sony-bravia': return 'Sony BRAVIA TV';
  }
}

function isAuthorized(header: string | undefined, protocolToken: string | undefined, expected: string): boolean {
  if (!expected) return true; // token disabled in config (not recommended)
  const candidate = header?.startsWith('Bearer ') ? header.slice(7) : protocolToken;
  return !!candidate && timingSafeEqual(candidate, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > 64 * 1024) {
        settled = true;
        reject(new HttpError(413, 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve(data ? JSON.parse(data) : null);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function parseRequestTarget(value: string | undefined): URL | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const target = new URL(value, 'http://hub.local');
    return target.origin === 'http://hub.local' ? target : null;
  } catch {
    return null;
  }
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || /[\/\x00-\x1f\x7f]/.test(decoded)) throw new Error('invalid segment');
    return decoded;
  } catch {
    throw new HttpError(400, 'Invalid URL path segment');
  }
}

function wsProtocolToken(header: string | string[] | undefined): string | undefined {
  const protocols = Array.isArray(header) ? header : header?.split(',') ?? [];
  return protocols.map((value) => value.trim()).find((value) => value.startsWith('homehub-auth.'))
    ?.slice('homehub-auth.'.length);
}

function isWsRequest(value: unknown): value is WsRequest {
  if (!isRecord(value)) return false;
  if (value.type !== 'ping' && value.type !== 'action') return false;
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || value.requestId.length > 128)) return false;
  if (value.type === 'action') {
    if (typeof value.id !== 'string' || value.id.length > 256 || typeof value.action !== 'string'
      || !/^[\x21-\x7e]{1,100}$/.test(value.action)) return false;
    if (value.params !== undefined && !isRecord(value.params)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function sendSocket(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    ws.close(1013, 'Client cannot keep up');
    return;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    console.error('Unable to serialize WebSocket event:', err);
    return;
  }
  ws.send(serialized, (err) => {
    if (err) {
      console.warn('WebSocket send failed:', err.message);
      ws.terminate();
    }
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
