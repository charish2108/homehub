const state = {
  settings: {
    url: 'http://192.168.1.50:8321',
  },
  devices: [],
  expandedDeviceIds: new Set(),
  expandedInputIds: new Set(),
  discoveryResults: [],
  deviceRevision: 0,
  refreshGeneration: 0,
};

const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const deviceCount = document.getElementById('deviceCount');
const roomCount = document.getElementById('roomCount');
const onlineCount = document.getElementById('onlineCount');
const deviceGrid = document.getElementById('deviceGrid');
const refreshBtn = document.getElementById('refreshBtn');
const discoverBtn = document.getElementById('discoverBtn');
const settingsBtn = document.getElementById('settingsBtn');
const discoveryResults = document.getElementById('discoveryResults');
const pairingModal = document.getElementById('pairingModal');
const pairingForm = document.getElementById('pairingForm');
const pairingTitle = document.getElementById('pairingTitle');
const pairingCode = document.getElementById('pairingCode');
const pairingCodeHint = document.getElementById('pairingCodeHint');
const pairingError = document.getElementById('pairingError');
const pairingSubmit = document.getElementById('pairingSubmit');
const pairingCancel = document.getElementById('pairingCancel');

let activePairing = null;

function visibleDevices(devices) {
  return devices.filter((device) => device.driver !== 'mock' && !device.id.startsWith('demo-'));
}

const remoteButtonLabels = {
  HOME: ['⌂', 'Home'],
  UP: ['▲', 'Up'],
  LEFT: ['◀', 'Left'],
  ENTER: ['OK', 'OK'],
  RIGHT: ['▶', 'Right'],
  DOWN: ['▼', 'Down'],
  BACK: ['↩', 'Back'],
  MENU: ['☰', 'Menu'],
  SETTINGS: ['⚙', 'Settings'],
  VOLUME_DOWN: ['🔉 −', 'Volume down'],
  MUTE: ['🔇', 'Mute'],
  VOLUME_UP: ['🔊 +', 'Volume up'],
  PLAY: ['▶', 'Play'],
  PAUSE: ['Ⅱ', 'Pause'],
  PLAY_PAUSE: ['▶Ⅱ', 'Play / pause'],
  STOP: ['■', 'Stop'],
  REWIND: ['≪', 'Rewind'],
  FAST_FORWARD: ['≫', 'Fast forward'],
  SOURCE: ['▣', 'Open input menu'],
  HDMI_1: ['HDMI 1', 'Switch to HDMI 1'],
  HDMI_2: ['HDMI 2', 'Switch to HDMI 2'],
  HDMI_3: ['HDMI 3', 'Switch to HDMI 3'],
  HDMI_4: ['HDMI 4', 'Switch to HDMI 4'],
  CHANNEL_DOWN: ['CH −', 'Channel down'],
  CHANNEL_UP: ['CH +', 'Channel up'],
};

const streamingApps = [
  { id: 'netflix', label: 'Netflix', mark: 'N' },
  { id: 'prime_video', label: 'Prime Video', mark: 'prime' },
  { id: 'hotstar', label: 'Hotstar', mark: '✦' },
  { id: 'youtube', label: 'YouTube', mark: '▶' },
];

function toggleDevice(deviceId) {
  if (state.expandedDeviceIds.has(deviceId)) {
    state.expandedDeviceIds.delete(deviceId);
  } else {
    state.expandedDeviceIds.add(deviceId);
  }
  renderDevices();
}

function setStatus(label, kind = 'live') {
  statusText.textContent = label;
  statusPill.textContent = kind === 'warning' ? 'Retrying' : kind === 'offline' ? 'Offline' : 'Live';
  statusPill.className = `status-pill ${kind === 'live' ? '' : kind}`.trim();
}

function renderMessage(title, message, messageClass = 'meta') {
  const card = document.createElement('div');
  card.className = 'device';
  card.setAttribute('role', 'listitem');

  const heading = document.createElement('div');
  heading.className = 'device-name';
  heading.textContent = title;
  card.append(heading);

  const detail = document.createElement('div');
  detail.className = messageClass;
  detail.textContent = message;
  card.append(detail);

  deviceGrid.replaceChildren(card);
}

function updateStats() {
  const rooms = new Set(state.devices.map((device) => device.room)).size;
  const online = state.devices.filter((device) => device.online).length;

  deviceCount.textContent = String(state.devices.length);
  roomCount.textContent = String(rooms);
  onlineCount.textContent = String(online);
}

function renderDevices() {
  if (!state.devices.length) {
    renderMessage('No devices', 'The hub is reachable but no devices are registered yet.');
    updateStats();
    return;
  }

  const cards = state.devices.map((device) => {
    const card = document.createElement('article');
    card.className = 'device';
    card.setAttribute('role', 'listitem');

    const expanded = state.expandedDeviceIds.has(device.id);
    card.setAttribute('aria-expanded', String(expanded));
    card.tabIndex = 0;

    const header = document.createElement('button');
    header.className = 'device-toggle';
    header.type = 'button';
    header.setAttribute('aria-expanded', String(expanded));
    header.addEventListener('click', () => toggleDevice(device.id));

    const headerDetails = document.createElement('div');
    headerDetails.className = 'device-header';

    const details = document.createElement('div');
    const name = document.createElement('h2');
    name.className = 'device-name';
    name.textContent = device.name;
    const room = document.createElement('div');
    room.className = 'device-room';
    room.textContent = device.room;
    details.append(name, room);

    const badge = document.createElement('span');
    badge.className = device.online ? 'device-badge' : 'device-badge device-offline';
    badge.textContent = device.online ? 'Online' : 'Offline';
    const disclosure = document.createElement('span');
    disclosure.className = 'meta';
    disclosure.textContent = expanded ? 'Hide controls ▲' : 'Show controls ▼';
    headerDetails.append(details, badge);
    header.append(headerDetails, disclosure);

    card.addEventListener('click', (event) => {
      if (event.target.closest('button, .actions')) return;
      toggleDevice(device.id);
    });
    card.addEventListener('keydown', (event) => {
      if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggleDevice(device.id);
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${device.class} • ${device.driverLabel}`;

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.hidden = !expanded;
    const availableActions = device.actions || [];
    const remoteAction = availableActions.find((action) => action.name === 'remote_key');
    const isTv = device.class === 'tv';
    const tvPowered = device.state.power !== false;

    const sendAction = async (action, params, button) => {
      button.disabled = true;
      button.classList.add('is-working');
      try {
        setStatus(`Sending ${action.label}…`, 'warning');
        await window.homehub.sendDeviceAction({ id: device.id, action: action.name, params });
        await refreshDevices();
        return true;
      } catch (error) {
        setStatus('Action failed', 'offline');
        alert(error instanceof Error ? error.message : 'Action failed');
        return false;
      } finally {
        button.disabled = false;
        button.classList.remove('is-working');
      }
    };

    if (isTv) {
      const powerAction = availableActions.find((action) =>
        ['power_toggle', 'toggle_power', 'power_on', 'power_off'].includes(action.name));
      if (powerAction) {
        const button = document.createElement('button');
        button.className = 'small-btn icon-btn';
        button.type = 'button';
        button.textContent = '⏻';
        button.title = tvPowered ? 'Power off' : 'Power on';
        button.setAttribute('aria-label', `${button.title} ${device.name}`);
        button.addEventListener('click', () => void sendAction(powerAction, {}, button));
        actions.append(button);
      }
    }

    if (remoteAction && (!isTv || tvPowered)) {
      const options = new Set(remoteAction.params?.find((param) => param.name === 'key')?.options || []);
      const remotePad = document.createElement('div');
      remotePad.className = 'remote-pad';
      const remoteRows = [
        ['HOME'],
        ['UP'],
        ['LEFT', 'ENTER', 'RIGHT'],
        ['DOWN'],
        ['BACK', 'MENU', 'SETTINGS'],
        ['VOLUME_DOWN', 'MUTE', 'VOLUME_UP'],
        ['PLAY', 'PLAY_PAUSE', 'PAUSE', 'STOP', 'REWIND', 'FAST_FORWARD'],
        ['CHANNEL_DOWN', 'CHANNEL_UP'],
      ];
      for (const row of remoteRows) {
        const remoteRow = document.createElement('div');
        remoteRow.className = 'remote-row';
        for (const key of row) {
          if (!options.has(key)) continue;
          const button = document.createElement('button');
          button.className = 'small-btn icon-btn';
          button.type = 'button';
          const [label, accessibleName] = remoteButtonLabels[key] || [key, key];
          button.textContent = label;
          button.title = accessibleName;
          button.setAttribute('aria-label', `${accessibleName} for ${device.name}`);
          button.addEventListener('click', () => void sendAction(remoteAction, { key }, button));
          remoteRow.append(button);
        }
        if (remoteRow.childElementCount) remotePad.append(remoteRow);
      }
      actions.append(remotePad);
    }

    if (remoteAction && (!isTv || tvPowered)) {
      const options = new Set(remoteAction.params?.find((param) => param.name === 'key')?.options || []);
      const inputs = document.createElement('div');
      inputs.className = 'app-launcher';
      const inputToggle = document.createElement('button');
      inputToggle.className = 'small-btn';
      inputToggle.type = 'button';
      inputToggle.textContent = '▣ Inputs';
      inputToggle.setAttribute('aria-expanded', String(state.expandedInputIds.has(device.id)));
      inputToggle.setAttribute('aria-label', `Show input options for ${device.name}`);
      inputs.append(inputToggle);
      const row = document.createElement('div');
      row.className = 'remote-row';
      row.hidden = !state.expandedInputIds.has(device.id);
      inputToggle.addEventListener('click', () => {
        if (state.expandedInputIds.has(device.id)) {
          state.expandedInputIds.delete(device.id);
        } else {
          state.expandedInputIds.add(device.id);
        }
        renderDevices();
      });
      for (const key of ['SOURCE', 'HDMI_1', 'HDMI_2', 'HDMI_3', 'HDMI_4']) {
        if (!options.has(key)) continue;
        const button = document.createElement('button');
        button.className = 'small-btn icon-btn';
        button.type = 'button';
        const [label, accessibleName] = remoteButtonLabels[key];
        button.textContent = label;
        button.title = accessibleName;
        button.setAttribute('aria-label', `${accessibleName} on ${device.name}`);
        button.addEventListener('click', () => void sendAction(remoteAction, { key }, button));
        row.append(button);
      }
      inputs.append(row);
      actions.append(inputs);
    }

    const launchAction = availableActions.find((action) => action.name === 'launch_app');
    const supportedApps = new Set(launchAction?.params?.find((param) => param.name === 'app')?.options || []);
    if (launchAction && supportedApps.size && (!isTv || tvPowered)) {
      const appLauncher = document.createElement('div');
      appLauncher.className = 'app-launcher';
      const heading = document.createElement('strong');
      heading.className = 'app-launcher-title';
      heading.textContent = 'Applications';
      appLauncher.append(heading);
      const appGrid = document.createElement('div');
      appGrid.className = 'app-launch-grid';
      for (const app of streamingApps) {
        if (!supportedApps.has(app.id)) continue;
        const button = document.createElement('button');
        button.className = 'app-launch-btn';
        button.dataset.app = app.id;
        button.type = 'button';
        button.setAttribute('aria-label', `Open ${app.label} on ${device.name}`);
        button.title = `Open ${app.label}`;
        const mark = document.createElement('span');
        mark.className = 'app-mark';
        mark.textContent = app.mark;
        const label = document.createElement('span');
        label.className = 'app-name';
        label.textContent = app.label;
        button.append(mark, label);
        button.addEventListener('click', () => void sendAction(launchAction, { app: app.id }, button));
        appGrid.append(button);
      }
      appLauncher.append(appGrid);
      actions.append(appLauncher);
    }

    if (availableActions.length) {
      for (const action of availableActions) {
        if (action.name === 'remote_key' || action.name === 'launch_app') continue;
        if (isTv && (action.name === 'power_toggle' || action.name === 'toggle_power'
            || action.name === 'power_on' || action.name === 'power_off')) continue;
        if (isTv && !tvPowered) continue;
        const button = document.createElement('button');
        button.className = 'small-btn';
        button.type = 'button';
        const iconLabels = { power_toggle: '⏻', mute_toggle: '🔇' };
        button.textContent = iconLabels[action.name] || action.label;
        button.title = action.label;
        button.setAttribute('aria-label', `${action.label} for ${device.name}`);
        button.addEventListener('click', async () => {
          const params = collectActionParams(action, device.name);
          if (params === null) return;
          await sendAction(action, params, button);
        });
        actions.append(button);
      }
    } else {
      const noActions = document.createElement('span');
      noActions.className = 'meta';
      noActions.textContent = 'No actions';
      actions.append(noActions);
    }

    card.append(header, meta, actions);
    return card;
  });

  deviceGrid.replaceChildren(...cards);
  updateStats();
}

function applyDeviceUpdate(next) {
  if (!next) return;
  const incoming = visibleDevices(Array.isArray(next) ? next : [next]);
  const map = new Map(state.devices.map((device) => [device.id, device]));
  for (const device of incoming) {
    if (device && device.id) {
      map.set(device.id, device);
    }
  }
  state.devices = [...map.values()];
  state.deviceRevision++;
  renderDevices();
}

function handleHubEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'hello' && Array.isArray(payload.devices)) {
    state.devices = visibleDevices(payload.devices);
    state.deviceRevision++;
    renderDevices();
    setStatus(`${state.devices.length} devices synced`, 'live');
  } else if (payload.type === 'state' && Array.isArray(payload.devices)) {
    applyDeviceUpdate(payload.devices);
    setStatus(`${state.devices.length} devices synced`, 'live');
  } else if (payload.type === 'state' && payload.device) {
    applyDeviceUpdate(payload.device);
  } else if (payload.type === 'device_removed' && payload.device) {
    state.devices = state.devices.filter((device) => device.id !== payload.device.id);
    state.deviceRevision++;
    renderDevices();
  } else if (payload.type === 'device_added' && payload.device) {
    applyDeviceUpdate(payload.device);
  } else if (payload.type === 'discovery' && Array.isArray(payload.found)) {
    showDiscoveryResults(payload.found);
  } else if (payload.type === 'error') {
    setStatus(payload.message || 'Hub connection issue', 'offline');
  } else if (payload.type === 'connection') {
    setStatus(payload.connected ? 'Live updates connected' : 'Hub connection issue, retrying…', payload.connected ? 'live' : 'warning');
  } else if (payload.type === 'settings' && payload.settings) {
    state.settings = payload.settings;
    void refreshDevices();
  }
}

function showDiscoveryResults(results) {
  state.discoveryResults = results;
  const heading = document.createElement('strong');
  heading.textContent = `Discovery found ${results.length} device${results.length === 1 ? '' : 's'}`;
  const list = document.createElement('ul');
  for (const item of results) {
    const row = document.createElement('li');
    const detail = document.createElement('span');
    const pairing = item.suggestedDriver === 'samsung-tv' || item.suggestedDriver === 'lg-webos'
      ? ' — approve the pairing prompt on the TV'
      : item.suggestedDriver === 'sony-bravia'
        ? ' — pair with the code displayed on the TV'
        : '';
    detail.textContent = `${item.name || item.host} — ${item.host}${item.port ? `:${item.port}` : ''} (${item.source})${pairing}`;
    row.append(detail);
    if (item.addedDeviceId) {
      const added = document.createElement('span');
      added.textContent = ' — Added';
      row.append(added);
    } else if (item.suggestedDriver === 'sony-bravia') {
      const pair = document.createElement('button');
      pair.className = 'small-btn';
      pair.type = 'button';
      pair.textContent = 'Pair';
      pair.addEventListener('click', async () => {
        pair.disabled = true;
        try {
          const session = await window.homehub.startPairing({ discoveryId: item.id });
          activePairing = { ...session, item, button: pair };
          pairingTitle.textContent = `Pair ${session.name}`;
          pairingCode.value = '';
          pairingError.hidden = true;
          pairingError.textContent = '';
          pairingCodeHint.textContent = 'Use characters 0–9 and A–F. Spaces or dashes are okay.';
          pairingModal.hidden = false;
          pairingCode.focus();
        } catch (error) {
          pair.disabled = false;
          setStatus('TV pairing failed', 'offline');
          showDiscoveryError(error instanceof Error ? error.message : String(error));
        }
      });
      row.append(' ', pair);
    } else if (item.suggestedDriver && !item.pairingRequired) {
      const add = document.createElement('button');
      add.className = 'small-btn';
      add.type = 'button';
      add.textContent = 'Add';
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          const result = await window.homehub.addDiscoveredDevice({ discoveryId: item.id });
          item.addedDeviceId = result.device.id;
          showDiscoveryResults(state.discoveryResults);
          await refreshDevices();
        } catch (error) {
          add.disabled = false;
          setStatus('Could not add device', 'offline');
          window.alert(error instanceof Error ? error.message : String(error));
        }
      });
      row.append(' ', add);
    } else if (item.setupNote) {
      const note = document.createElement('span');
      note.textContent = ` — ${item.setupNote}`;
      row.append(note);
    } else if (item.pairingRequired) {
      const note = document.createElement('span');
      note.textContent = ' — one-time bridge pairing required';
      row.append(note);
    } else {
      const note = document.createElement('span');
      note.textContent = ' — automatic setup is not available for this device yet';
      row.append(note);
    }
    list.append(row);
  }
  if (!results.length) {
    const row = document.createElement('li');
    row.textContent = 'No devices found on the hub host network.';
    list.append(row);
  }
  const hint = document.createElement('p');
  hint.className = 'meta';
  hint.textContent = 'Devices are added to the hub automatically. Pairing approval may still be required on the device itself.';
  discoveryResults.replaceChildren(heading, list);
  discoveryResults.append(hint);
  discoveryResults.hidden = false;
}

function renderPairingError(message) {
  pairingError.textContent = message;
  pairingError.hidden = false;
}

function showDiscoveryError(message) {
  const error = document.createElement('div');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  discoveryResults.append(error);
  discoveryResults.hidden = false;
}

async function closePairingDialog(cancelSession = true) {
  const session = activePairing;
  activePairing = null;
  pairingModal.hidden = true;
  pairingCode.value = '';
  if (cancelSession && session) {
    try {
      await window.homehub.cancelPairing({ sessionId: session.sessionId });
    } catch (error) {
      setStatus('Could not cancel TV pairing', 'offline');
      showDiscoveryError(error instanceof Error ? error.message : String(error));
    }
  }
}

pairingCode.addEventListener('input', () => {
  const code = pairingCode.value.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  if (pairingCode.value !== code) pairingCode.value = code;
  pairingError.hidden = true;
  pairingError.textContent = '';
});

pairingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activePairing) return;
  const code = pairingCode.value.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^[0-9a-f]{6}$/i.test(code)) {
    renderPairingError('Enter the six-character TV code using 0–9 or A–F. Spaces and dashes are ignored.');
    pairingCode.focus();
    return;
  }

  const session = activePairing;
  pairingSubmit.disabled = true;
  pairingCancel.disabled = true;
  pairingError.hidden = true;
  try {
    const result = await window.homehub.confirmPairing({ sessionId: session.sessionId, code });
    session.item.addedDeviceId = result.device.id;
    await closePairingDialog(false);
    showDiscoveryResults(state.discoveryResults);
    await refreshDevices();
  } catch (error) {
    await closePairingDialog(false);
    setStatus('TV pairing failed', 'offline');
    showDiscoveryError(error instanceof Error ? error.message : String(error));
  } finally {
    pairingSubmit.disabled = false;
    pairingCancel.disabled = false;
    session.button.disabled = false;
  }
});

pairingCancel.addEventListener('click', () => {
  void closePairingDialog();
});

pairingModal.addEventListener('click', (event) => {
  if (event.target === pairingModal) void closePairingDialog();
});

async function refreshDevices() {
  const generation = ++state.refreshGeneration;
  const revision = state.deviceRevision;
  try {
    setStatus('Loading devices…', 'live');
    const devices = visibleDevices(await window.homehub.fetchDevices());
    if (generation !== state.refreshGeneration || revision !== state.deviceRevision) return;
    state.devices = devices;
    renderDevices();
    setStatus(`${state.devices.length} devices synced`, 'live');
  } catch (error) {
    if (generation !== state.refreshGeneration || revision !== state.deviceRevision) return;
    setStatus('Hub unreachable', 'offline');
    renderMessage('Connection error', error instanceof Error ? error.message : String(error), 'error');
  }
}

function collectActionParams(action, deviceName) {
    const params = {};
    for (const param of action.params || []) {
      let fallback = '';
      if (param.type === 'number') {
        const defaultIsValid = typeof param.default === 'number'
          && Number.isFinite(param.default)
          && (param.min === undefined || param.default >= param.min)
          && (param.max === undefined || param.default <= param.max);
        const suggested = defaultIsValid ? param.default : param.min ?? param.max;
        fallback = suggested === undefined ? '' : String(suggested);
      } else if (param.type === 'boolean') {
        fallback = String(Boolean(param.default));
      } else if (param.type === 'enum' && param.options?.length) {
        fallback = param.options.includes(param.default) ? param.default : param.options[0];
      } else if (param.default !== undefined) {
        fallback = String(param.default);
      }
      const options = param.type === 'enum' && param.options?.length
        ? ` (choose: ${param.options.join(', ')})`
        : '';
      const answer = window.prompt(
        `${param.label || param.name} for ${deviceName}${options}`,
        fallback,
      );
      if (answer === null) return null;

      if (param.type === 'number') {
        const number = Number(answer);
        if (!Number.isFinite(number)
            || (param.min !== undefined && number < param.min)
            || (param.max !== undefined && number > param.max)) {
          window.alert(`${param.label || param.name} must be a number${param.min !== undefined ? ` at least ${param.min}` : ''}${param.max !== undefined ? ` and at most ${param.max}` : ''}.`);
          return null;
        }
        params[param.name] = number;
      } else if (param.type === 'boolean') {
        if (!['true', 'false'].includes(answer.toLowerCase())) {
          window.alert(`${param.label || param.name} must be true or false.`);
          return null;
        }
        params[param.name] = answer.toLowerCase() === 'true';
      } else if (param.type === 'enum') {
        if (!param.options?.includes(answer)) {
          window.alert(`Choose one of: ${(param.options || []).join(', ')}`);
          return null;
        }
        params[param.name] = answer;
      } else {
        params[param.name] = answer;
      }
    }
    return params;
}

async function applySettings() {
  const settings = await window.homehub.loadPublicSettings();
  state.settings = settings;
  await refreshDevices();
}

settingsBtn.addEventListener('click', async () => {
  await window.homehub.openSettings();
});

refreshBtn.addEventListener('click', () => {
  void refreshDevices();
});

discoverBtn.addEventListener('click', async () => {
  discoverBtn.disabled = true;
  discoveryResults.hidden = true;
  setStatus('Scanning from the hub host…', 'warning');
  try {
    const result = await window.homehub.discoverDevices();
    showDiscoveryResults(result.found);
    setStatus(`Discovery complete: ${result.found.length} candidate(s)`, 'live');
  } catch (error) {
    setStatus('Discovery failed', 'offline');
    discoveryResults.textContent = error instanceof Error ? error.message : String(error);
    discoveryResults.hidden = false;
  } finally {
    discoverBtn.disabled = false;
  }
});

window.homehub.onHubEvent(handleHubEvent);

void applySettings();
