const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, safeStorage } = require('electron');
const fs = require('fs');
const http = require('node:http');
const https = require('node:https');
const path = require('path');
const dns = require('node:dns/promises');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const DEFAULT_SETTINGS = Object.freeze({
  url: 'http://192.168.1.50:8321',
  token: '',
  launchAtLogin: false,
});
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ALLOWED_PAGE_URLS = new Set(
  ['index.html', 'settings.html'].map((file) => pathToFileURL(path.join(__dirname, file)).href),
);

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let hubSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let socketGeneration = 0;
let quitting = false;
let settings = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('activate', () => showMainWindow());
  app.whenReady().then(async () => {
    try {
      settings = loadSettings();
      applyLaunchAtLogin(settings.launchAtLogin);
      createTray();
      createMainWindow();
      connectHubSocket();
    } catch (error) {
      console.error('HomeHub failed to initialize:', error);
      app.quit();
    }
  });
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'homehub-settings.json');
}

function loadSettings() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw new Error(`Unable to read desktop settings: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error('Desktop settings must be a JSON object');
  let token = '';
  if (typeof parsed.tokenEncrypted === 'string' && parsed.tokenEncrypted) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable; hub token was not loaded');
    token = safeStorage.decryptString(Buffer.from(parsed.tokenEncrypted, 'base64'));
  } else if (typeof parsed.token === 'string') {
    token = parsed.token;
  }
  const loaded = validateSettings({ ...DEFAULT_SETTINGS, ...parsed, token });
  if (parsed.token !== undefined) persistSettings(loaded);
  return loaded;
}

function validateSettings(value) {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.token !== 'string') {
    throw new Error('Settings must include a hub URL and token string');
  }
  if (typeof value.launchAtLogin !== 'boolean') throw new Error('launchAtLogin must be a boolean');

  const url = value.url.trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Hub URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Hub URL must contain only an HTTP(S) origin without credentials or a path');
  }
  if (!/^[\x20-\x7e]*$/.test(url) || (value.token !== '' && !/^[A-Za-z0-9_-]{16,}$/.test(value.token))) {
    throw new Error('Hub URL must contain printable ASCII; token must be empty or at least 16 base64url characters');
  }
  return { url: parsed.origin, token: value.token, launchAtLogin: value.launchAtLogin };
}

function persistSettings(value) {
  const next = validateSettings(value);
  if (next.token && !safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable; refusing to store the hub token as plaintext');
  }
  const file = settingsPath();
  const temporary = `${file}.${process.pid}.tmp`;
  const stored = {
    url: next.url,
    tokenEncrypted: next.token ? safeStorage.encryptString(next.token).toString('base64') : '',
    launchAtLogin: next.launchAtLogin,
  };
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  settings = next;
  applyLaunchAtLogin(next.launchAtLogin);
  connectHubSocket();
  if (tray) setTrayMenu();
  sendToMainWindow({ type: 'settings', settings: { url: next.url, launchAtLogin: next.launchAtLogin } });
  return { url: next.url, launchAtLogin: next.launchAtLogin };
}

function trustedIpc(event, page) {
  return event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === pathToFileURL(path.join(__dirname, page)).href;
}

function registerIpc(channel, page, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedIpc(event, page)) throw new Error('IPC request rejected for an untrusted frame');
    return handler(...args);
  });
}

registerIpc('settings:load', 'settings.html', () => ({ ...settings }));
registerIpc('settings:public', 'index.html', () => ({
  url: settings.url,
  launchAtLogin: settings.launchAtLogin,
}));
registerIpc('settings:save', 'settings.html', (next) => persistSettings(next));
registerIpc('window:open-settings', 'index.html', () => {
  showSettingsWindow();
});
registerIpc('hub:fetch-devices', 'index.html', async () => {
  const result = await hubRequest('/api/devices');
  if (!Array.isArray(result.devices)) throw new Error('Hub returned an invalid device list');
  return result.devices;
});
registerIpc('hub:discover', 'index.html', async () => {
  const result = await hubRequest('/api/discover', { method: 'POST' });
  if (!Array.isArray(result.found)) throw new Error('Hub returned an invalid discovery response');
  return result;
});
registerIpc('hub:add-discovered', 'index.html', async (request) => {
  if (!isRecord(request) || typeof request.discoveryId !== 'string'
      || !/^[\x21-\x7e]{1,256}$/.test(request.discoveryId)) {
    throw new Error('Invalid discovered-device request');
  }
  return hubRequest('/api/devices/discovered', {
    method: 'POST',
    body: { discoveryId: request.discoveryId },
  });
});
registerIpc('hub:start-pairing', 'index.html', async (request) => {
  if (!isRecord(request) || typeof request.discoveryId !== 'string'
      || !/^[\x21-\x7e]{1,256}$/.test(request.discoveryId)) {
    throw new Error('Invalid discovered-TV pairing request');
  }
  return hubRequest('/api/devices/discovered/pair', {
    method: 'POST',
    body: { discoveryId: request.discoveryId },
  });
});
registerIpc('hub:confirm-pairing', 'index.html', async (request) => {
  if (!isRecord(request) || typeof request.sessionId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(request.sessionId)
      || typeof request.code !== 'string' || !/^[0-9a-f]{6}$/i.test(request.code)) {
    throw new Error('Enter the six-character code shown on the TV (0–9 or A–F)');
  }
  return hubRequest('/api/devices/discovered/pair/confirm', {
    method: 'POST',
    body: { sessionId: request.sessionId, code: request.code },
    timeoutMs: 12000,
  });
});
registerIpc('hub:cancel-pairing', 'index.html', async (request) => {
  if (!isRecord(request) || typeof request.sessionId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(request.sessionId)) {
    throw new Error('Invalid TV pairing session');
  }
  return hubRequest('/api/devices/discovered/pair/cancel', {
    method: 'POST',
    body: { sessionId: request.sessionId },
  });
});
registerIpc('hub:device-action', 'index.html', async (request) => {
  if (!isRecord(request) || typeof request.id !== 'string'
      || !/^[\x21-\x7e]{1,256}$/.test(request.id)
      || typeof request.action !== 'string' || !/^[\x21-\x7e]{1,100}$/.test(request.action)
      || (request.params !== undefined && !isRecord(request.params))) {
    throw new Error('Invalid device action request');
  }
  if (Buffer.byteLength(JSON.stringify(request.params ?? {})) > 64 * 1024) {
    throw new Error('Device action parameters exceed 64 KiB');
  }
  return hubRequest(`/api/devices/${encodeURIComponent(request.id)}/action`, {
    method: 'POST',
    body: { action: request.action, params: request.params ?? {} },
  });
});
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!ALLOWED_PAGE_URLS.has(url)) event.preventDefault();
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 430,
    minWidth: 480,
    minHeight: 400,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow && !mainWindow.isDestroyed()),
    resizable: false,
    backgroundColor: '#0f172a',
    show: false,
    title: 'HomeHub Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (event, url) => {
    if (!ALLOWED_PAGE_URLS.has(url)) event.preventDefault();
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function showSettingsWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  showMainWindow();
  createSettingsWindow();
}

function createTray() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 4; y < 28; y++) {
    for (let x = 6; x < 26; x++) {
      if (x < 11 || x >= 21 || (y >= 14 && y < 19)) {
        const offset = (y * size + x) * 4;
        const color = process.platform === 'darwin' ? 255 : 75;
        pixels[offset] = color;
        pixels[offset + 1] = process.platform === 'darwin' ? 255 : 197;
        pixels[offset + 2] = process.platform === 'darwin' ? 255 : 255;
        pixels[offset + 3] = 255;
      }
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('HomeHub');
  setTrayMenu();
  tray.on('click', showMainWindow);
}

function setTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open HomeHub', click: showMainWindow },
    { label: 'Discover devices', click: () => runDiscoveryFromTray() },
    { label: 'Settings…', click: showSettingsWindow },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => {
        try {
          persistSettings({ ...settings, launchAtLogin: item.checked });
        } catch (error) {
          item.checked = !item.checked;
          console.error('Unable to update launch-at-login setting:', error);
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit HomeHub', click: () => app.quit() },
  ]));
}

async function runDiscoveryFromTray() {
  try {
    const result = await hubRequest('/api/discover', { method: 'POST' });
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub:event', { type: 'discovery', ...result, ts: Date.now() });
    }
  } catch (error) {
    console.error('Tray discovery failed:', error);
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub:event', { type: 'error', message: error.message, ts: Date.now() });
    }
  }
}

function applyLaunchAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function connectHubSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const generation = ++socketGeneration;
  if (hubSocket) {
    closeHubSocket(hubSocket);
    hubSocket = null;
  }
  if (!settings) return;
  const currentSettings = settings;
  const deadline = Date.now() + 8000;
  const target = new URL(currentSettings.url);
  void resolvePrivateAddress(target.hostname, remainingTime(deadline)).then((resolved) => {
    if (generation !== socketGeneration || quitting) return;
    const handshakeTimeout = remainingTime(deadline);
    if (handshakeTimeout <= 0) throw new Error('Hub connection timed out');
    const protocols = currentSettings.token ? ['homehub', `homehub-auth.${currentSettings.token}`] : ['homehub'];
    const socket = new WebSocket(`${currentSettings.url.replace(/^http/, 'ws')}/ws`, protocols, {
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      headers: { origin: 'null' },
      handshakeTimeout,
      lookup: pinnedLookup(resolved),
    });
    hubSocket = socket;
    socket.on('open', () => {
      if (generation !== socketGeneration) return;
      reconnectDelayMs = 1000;
      sendToMainWindow({ type: 'connection', connected: true });
    });
    socket.on('message', (data) => {
      try {
        const event = JSON.parse(String(data));
        if (generation === socketGeneration && isRecord(event) && typeof event.type === 'string') {
          sendToMainWindow(event);
        }
      } catch (error) {
        console.warn('Ignoring invalid hub WebSocket message:', error.message);
      }
    });
    socket.on('close', () => {
      if (hubSocket !== socket || generation !== socketGeneration) return;
      hubSocket = null;
      sendToMainWindow({ type: 'connection', connected: false });
      scheduleSocketReconnect();
    });
    socket.on('error', (error) => {
      console.warn('Hub WebSocket connection failed:', error.message);
      sendToMainWindow({ type: 'connection', connected: false });
    });
  }).catch((error) => {
    if (generation !== socketGeneration) return;
    console.warn('Hub WebSocket target rejected:', error.message);
    sendToMainWindow({ type: 'connection', connected: false });
    scheduleSocketReconnect();
  });
}

function closeHubSocket(socket) {
  socket.removeAllListeners();
  socket.on('error', () => {});
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Connection replaced');
}

function sendToMainWindow(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hub:event', event);
}

function scheduleSocketReconnect() {
  if (reconnectTimer || quitting) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHubSocket();
  }, delay);
  reconnectTimer.unref();
}

async function hubRequest(route, options = {}) {
  const currentSettings = settings;
  if (!currentSettings) throw new Error('Hub settings are unavailable');
  const hubUrl = new URL(currentSettings.url);
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  const resolved = await resolvePrivateAddress(hubUrl.hostname, remainingTime(deadline));
  try {
    const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
    return await requestHub(
      new URL(route, currentSettings.url),
      {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
          ...(currentSettings.token ? { Authorization: `Bearer ${currentSettings.token}` } : {}),
          ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {}),
        },
        lookup: pinnedLookup(resolved),
      },
      requestBody,
      remainingTime(deadline),
    );
  } catch (error) {
    if (Date.now() >= deadline) throw new Error('Hub request timed out after 8 seconds');
    throw error;
  }
}

function requestHub(url, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new Error('Hub request timed out after 8 seconds'));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let request;
    const timer = setTimeout(() => request.destroy(new Error('Hub request timed out after 8 seconds')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    request = transport.request(url, { ...options, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Hub response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = responseText ? JSON.parse(responseText) : {};
        } catch {
          finish(new Error('Hub returned invalid JSON'));
          return;
        }
        if (!isRecord(parsed)) {
          finish(new Error('Hub returned an invalid response'));
          return;
        }
        if ((response.statusCode ?? 500) >= 400) {
          finish(new Error(parsed.error || `Hub request failed (${response.statusCode})`));
          return;
        }
        finish(null, parsed);
      });
      response.on('error', (error) => finish(error));
    });
    request.on('timeout', () => request.destroy(new Error('Hub request timed out after 8 seconds')));
    request.on('error', (error) => finish(error));
    if (body) request.write(body);
    request.end();
  });
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function pinnedLookup(resolved) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
    else callback(null, resolved.address, resolved.family);
  };
}

async function resolvePrivateAddress(host, timeoutMs) {
  if (timeoutMs <= 0) throw new Error('Hub hostname resolution timed out');
  const normalized = host.replace(/^\[|\]$/g, '');
  if (net.isIP(normalized)) {
    if (!isPrivateAddress(normalized)) throw new Error('Hub must be on a private network');
    return { address: normalized, family: net.isIP(normalized) };
  }
  if (!/^(localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(\.local|\.lan)?$/i.test(host)) {
    throw new Error('Hub host must be a private IP or local hostname');
  }
  let timer;
  const addresses = await Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Hub hostname resolution timed out')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPrivateAddress(address))) {
    throw new Error('Hub hostname must resolve only to private addresses');
  }
  return addresses[0];
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 10 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || first === 127 || (first === 169 && second === 254);
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(reconnectTimer);
  if (hubSocket) closeHubSocket(hubSocket);
  hubSocket = null;
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') app.quit();
});
