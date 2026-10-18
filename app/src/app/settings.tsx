import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { DEFAULT_HUB_URL, type HubSettings, checkHubConnection, loadHubSettings, saveHubSettings } from '../lib/hub';

export default function SettingsScreen() {
  const [url, setUrl] = useState(DEFAULT_HUB_URL);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void loadHubSettings().then((settings) => {
      if (active) {
        setUrl(settings.url);
        setToken(settings.token);
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load saved settings');
    });
    return () => {
      active = false;
    };
  }, []);

  const getSettings = (): HubSettings => {
    const normalizedUrl = url.trim().replace(/\/+$/, '');
    const parsedUrl = new URL(normalizedUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Hub URL must start with http:// or https://');
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== '/') {
      throw new Error('Enter the hub origin only, without credentials, a path, or query parameters');
    }
    return { url: normalizedUrl, token: token.trim() };
  };

  const onSave = async () => {
    setError(null);
    setMessage(null);
    try {
      const next = getSettings();
      await saveHubSettings(next);
      setUrl(next.url);
      setToken(next.token);
      setMessage('Settings saved. Return to Home to reconnect.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save hub settings');
    }
  };

  const onCheckConnection = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await checkHubConnection(getSettings());
      setMessage(`Connected to ${result.homeName} · ${result.devices} devices`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reach the hub');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Hub settings</Text>
      <Text style={styles.label}>Hub URL</Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="http://192.168.1.50:8321"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Hub URL"
        style={styles.input}
      />

      <Text style={styles.label}>Token</Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="Bearer token from config.json"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Hub access token"
        style={styles.input}
      />

      <Text style={styles.helpText}>Use the hub machine’s LAN address and the token shown in hub/config.json. For Android emulators, the host machine is usually reachable at http://10.0.2.2:8321.</Text>
      {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.messageText}>{message}</Text> : null}

      <Pressable style={[styles.button, busy && styles.disabledButton]} onPress={() => void onCheckConnection()} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Checking…' : 'Test connection'}</Text>
      </Pressable>
      <Pressable style={styles.secondaryButton} onPress={() => void onSave()}>
        <Text style={styles.buttonText}>Save settings</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0f172a',
    padding: 20,
  },
  title: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 20,
  },
  label: {
    color: '#cbd5e1',
    fontSize: 13,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    backgroundColor: '#111827',
    borderColor: '#1f2937',
    borderWidth: 1,
    borderRadius: 12,
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 18,
  },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#f8fafc',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  disabledButton: {
    opacity: 0.6,
  },
  helpText: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 19,
    marginTop: -4,
    marginBottom: 16,
  },
  errorText: {
    color: '#fca5a5',
    marginBottom: 12,
  },
  messageText: {
    color: '#86efac',
    marginBottom: 12,
  },
});
