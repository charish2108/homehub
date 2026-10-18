const settingsUrl = document.getElementById('settingsUrl');
const settingsToken = document.getElementById('settingsToken');
const launchAtLogin = document.getElementById('launchAtLogin');
const settingsError = document.getElementById('settingsError');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');

async function loadSettings() {
  const settings = await window.homehub.loadSettings();
  settingsUrl.value = settings.url || 'http://192.168.1.50:8321';
  settingsToken.value = settings.token || '';
  launchAtLogin.checked = Boolean(settings.launchAtLogin);
}

saveBtn.addEventListener('click', async () => {
  const next = {
    url: settingsUrl.value.trim() || 'http://192.168.1.50:8321',
    token: settingsToken.value.trim(),
    launchAtLogin: launchAtLogin.checked,
  };

  saveBtn.disabled = true;
  settingsError.textContent = '';
  try {
    await window.homehub.saveSettings(next);
    window.close();
  } catch (error) {
    settingsError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', () => {
  window.close();
});

void loadSettings();
