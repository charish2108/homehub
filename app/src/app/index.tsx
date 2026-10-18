import { Link, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  addDiscoveredDevice,
  cancelSonyPairing,
  completeSonyPairing,
  discoverDevices,
  loadHubSettings,
  sendDeviceAction,
  startSonyPairing,
  type DiscoveryResult,
  type DeviceInfo,
  type HubSettings,
} from '../lib/hub';
import { useHubDevices } from '../hooks/useHubDevices';
import DeviceControls from '../components/DeviceControls';

export default function HomeScreen() {
  const { devices, status, error, refresh } = useHubDevices();
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState<DiscoveryResult[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [addingDiscoveryId, setAddingDiscoveryId] = useState<string | null>(null);
  const [pairingSession, setPairingSession] = useState<{ sessionId: string; name: string; host: string; settings: HubSettings } | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  const rooms = useMemo(() => {
    const byRoom = new Map<string, DeviceInfo[]>();
    for (const device of devices) {
      const list = byRoom.get(device.room) ?? [];
      list.push(device);
      byRoom.set(device.room, list);
    }
    return [...byRoom.entries()].map(([name, roomDevices]) => ({ name, devices: roomDevices }));
  }, [devices]);

  const scanNetwork = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const settings = await loadHubSettings();
      const result = await discoverDevices(settings);
      setDiscoveryResults(result.found);
    } catch (cause) {
      setDiscoveryError(cause instanceof Error ? cause.message : 'Network discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const addDevice = async (result: DiscoveryResult) => {
    setAddingDiscoveryId(result.id);
    setDiscoveryError(null);
    try {
      const settings = await loadHubSettings();
      const device = await addDiscoveredDevice(settings, result.id);
      setDiscoveryResults((current) => current?.map((item) =>
        item.id === result.id ? { ...item, addedDeviceId: device.id } : item) ?? null);
    } catch (cause) {
      setDiscoveryError(cause instanceof Error ? cause.message : 'Could not add discovered device');
    } finally {
      setAddingDiscoveryId(null);
    }
  };

  const beginSonyPairing = async (result: DiscoveryResult) => {
    setAddingDiscoveryId(result.id);
    setDiscoveryError(null);
    try {
      const settings = await loadHubSettings();
      const session = await startSonyPairing(settings, result.id);
      setPairingCode('');
      setPairingSession({ ...session, host: result.host, settings });
    } catch (cause) {
      setDiscoveryError(cause instanceof Error ? cause.message : 'Could not start TV pairing');
    } finally {
      setAddingDiscoveryId(null);
    }
  };

  const finishSonyPairing = async () => {
    if (!pairingSession) return;
    const code = pairingCode.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (!/^[0-9a-f]{6}$/i.test(code)) {
      setDiscoveryError('Enter the six-character TV code using 0–9 or A–F.');
      return;
    }
    setPairingBusy(true);
    setDiscoveryError(null);
    try {
      const device = await completeSonyPairing(pairingSession.settings, pairingSession.sessionId, code);
      setDiscoveryResults((current) => current?.map((item) =>
        item.host === pairingSession.host ? { ...item, addedDeviceId: device.id } : item) ?? null);
      setPairingSession(null);
      await refresh();
    } catch (cause) {
      setPairingSession(null);
      setDiscoveryError(cause instanceof Error ? cause.message : 'Could not pair the TV');
    } finally {
      setPairingBusy(false);
    }
  };

  const cancelPairing = () => {
    if (pairingSession) {
      void cancelSonyPairing(pairingSession.settings, pairingSession.sessionId).catch((cause: unknown) => {
        setDiscoveryError(cause instanceof Error ? cause.message : 'Could not cancel TV pairing');
      });
    }
    setPairingSession(null);
    setPairingCode('');
  };

  const widgets = useMemo(() => {
    return devices.map((device) => ({
      id: device.id,
      label: device.name,
      status:
        device.state.power === false
          ? 'Off'
          : device.state.volume !== undefined
            ? `${device.state.volume}%`
            : device.state.targetTemperature !== undefined
              ? `${device.state.targetTemperature}°C`
              : device.online
                ? 'Online'
                : 'Offline',
      room: device.room,
      color: device.class === 'tv' ? '#60a5fa' : device.class === 'ac' ? '#34d399' : '#fbbf24',
    }));
  }, [devices]);

  const runDeviceAction = async (deviceId: string, name: string, params: Record<string, unknown> = {}): Promise<boolean> => {
    setBusyAction(name);
    setControlError(null);
    try {
      const settings = await loadHubSettings();
      await sendDeviceAction(settings, deviceId, name, params);
      await refresh();
      return true;
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'Device action failed');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>Home</Text>
          <Text style={styles.title}>Smart home overview</Text>
        </View>
        <Pressable style={styles.settingsButton} onPress={() => router.push('/settings')}>
          <Text style={styles.settingsButtonText}>Settings</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Hub offline</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => router.push('/settings')}>
            <Text style={styles.secondaryButtonText}>Update hub settings</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Network status</Text>
        <Text style={styles.heroValue}>{status === 'connecting' ? 'Connecting to hub…' : `${devices.length} devices`}</Text>
        <Text style={[styles.connectionStatus, status === 'connected' ? styles.online : styles.offline]}>
          {status === 'connected' ? 'Live updates connected' : status === 'offline' ? 'Connection offline · retrying' : 'Loading device status'}
        </Text>
        <Text style={styles.heroMeta}>{rooms.length} room{rooms.length === 1 ? '' : 's'} • local-only</Text>
      </View>

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Rooms</Text>
        <Text style={styles.sectionMeta}>Organized by zone</Text>
      </View>
      <Pressable style={styles.scanButton} onPress={() => void scanNetwork()} disabled={discovering}>
        <Text style={styles.scanButtonText}>{discovering ? 'Scanning local network…' : 'Discover devices (mDNS / SSDP)'}</Text>
      </Pressable>
      {discoveryError ? <Text style={styles.errorText}>{discoveryError}</Text> : null}
      {discoveryResults ? (
        <View style={styles.discoveryCard}>
          <Text style={styles.discoveryTitle}>
            {discoveryResults.length ? `${discoveryResults.length} device${discoveryResults.length === 1 ? '' : 's'} found` : 'No devices found'}
          </Text>
          {discoveryResults.map((result) => (
            <View key={`${result.source}:${result.id}`} style={styles.discoveryDevice}>
              <View style={styles.discoveryDetails}>
                <Text style={styles.discoveryRow}>
                  {result.name ?? result.id} · {result.host}{result.port ? `:${result.port}` : ''} · {result.source.toUpperCase()}
                </Text>
                <Text style={styles.discoveryHint}>
                  {result.addedDeviceId
                    ? 'Added to your home'
                    : result.setupNote
                      ? result.setupNote
                    : result.pairingRequired
                      ? result.suggestedDriver === 'sony-bravia'
                        ? 'Tap Pair, then enter the code shown on the TV'
                        : 'Found, but this device needs a one-time bridge pairing step'
                      : result.suggestedDriver
                        ? `${result.suggestedClass} · ${result.suggestedDriver}${result.suggestedDriver === 'samsung-tv' || result.suggestedDriver === 'lg-webos' ? ' · approve the pairing prompt on the TV' : ''}`
                        : 'Found on the network; automatic setup is not available for this device yet'}
                </Text>
              </View>
              {result.addedDeviceId ? (
                <Text style={styles.addedLabel}>Added</Text>
              ) : result.suggestedDriver === 'sony-bravia' ? (
                <Pressable
                  style={styles.addButton}
                  onPress={() => void beginSonyPairing(result)}
                  disabled={addingDiscoveryId !== null}
                >
                  <Text style={styles.addButtonText}>
                    {addingDiscoveryId === result.id ? 'Connecting…' : 'Pair'}
                  </Text>
                </Pressable>
              ) : result.suggestedDriver && !result.pairingRequired ? (
                <Pressable
                  style={styles.addButton}
                  onPress={() => void addDevice(result)}
                  disabled={addingDiscoveryId !== null}
                >
                  <Text style={styles.addButtonText}>
                    {addingDiscoveryId === result.id ? 'Adding…' : 'Add'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          <Text style={styles.discoveryHint}>
            Scan from the hub-connected LAN. Supported devices can be added here; private-network pairing approval may still be required on the device.
          </Text>
        </View>
      ) : null}
      <Modal
        visible={pairingSession !== null}
        transparent
        animationType="fade"
        onRequestClose={cancelPairing}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.pairingModal}>
            <Text style={styles.discoveryTitle}>Pair {pairingSession?.name ?? 'Sony BRAVIA TV'}</Text>
            <Text style={styles.discoveryHint}>
              A code should appear on your TV. Enter all six characters (0–9 or A–F) to finish pairing.
            </Text>
            <TextInput
              style={styles.pairingInput}
              value={pairingCode}
              onChangeText={(value) => setPairingCode(value.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase())}
              autoCapitalize="characters"
              maxLength={6}
              placeholder="6-character code"
              placeholderTextColor="#64748b"
              autoFocus
              editable={!pairingBusy}
            />
            <View style={styles.pairingActions}>
              <Pressable style={styles.secondaryButton} onPress={cancelPairing} disabled={pairingBusy}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.addButton} onPress={() => void finishSonyPairing()} disabled={pairingBusy}>
                <Text style={styles.addButtonText}>{pairingBusy ? 'Pairing…' : 'Pair TV'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {rooms.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.roomList}
        >
          {rooms.map((room) => (
            <View key={room.name} style={styles.roomCard}>
              <Text style={styles.roomName}>{room.name}</Text>
              <Text style={styles.roomStats}>{room.devices.length} devices</Text>
              <Text style={styles.roomBadge}>{room.devices.filter((device) => device.online).length} active</Text>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No devices reported by the hub yet.</Text>
        </View>
      )}

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Live widgets</Text>
        <Text style={styles.sectionMeta}>Updated locally</Text>
      </View>
      {controlError ? <Text style={styles.errorText}>{controlError}</Text> : null}
      {widgets.length ? (
        <View style={styles.widgetGrid}>
          {widgets.map((widget) => {
            const device = devices.find((item) => item.id === widget.id);
            const expanded = expandedDeviceId === widget.id;
            return (
              <View key={widget.id} style={[styles.widgetCard, expanded && styles.widgetExpanded]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  style={styles.widgetSummary}
                  onPress={() => setExpandedDeviceId(expanded ? null : widget.id)}
                >
                  <View style={[styles.widgetDot, { backgroundColor: widget.color }]} />
                  <Text style={styles.widgetTitle}>{widget.label}</Text>
                  <Text style={styles.widgetStatus}>{widget.status}</Text>
                  <Text style={styles.widgetRoom}>{widget.room}</Text>
                  <Text style={styles.widgetRoom}>{expanded ? 'Hide controls' : 'Tap to expand controls'}</Text>
                </Pressable>
                {expanded && device ? (
                  <View style={styles.widgetControls}>
                    <DeviceControls
                      device={device}
                      onAction={(name, params) => runDeviceAction(device.id, name, params)}
                      busyAction={busyAction}
                    />
                    <Link href={{ pathname: '/device/[id]', params: { id: device.id } }} asChild>
                      <Pressable style={styles.detailsButton}>
                        <Text style={styles.secondaryButtonText}>Device details</Text>
                      </Pressable>
                    </Link>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>The hub is reachable but no devices are active.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  eyebrow: {
    color: '#93c5fd',
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  title: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
  },
  settingsButton: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  settingsButtonText: {
    color: '#f8fafc',
    fontWeight: '600',
  },
  heroCard: {
    backgroundColor: '#111827',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1f2937',
    marginBottom: 24,
  },
  heroLabel: {
    color: '#94a3b8',
    fontSize: 12,
    marginBottom: 6,
  },
  heroValue: {
    color: '#f8fafc',
    fontSize: 30,
    fontWeight: '800',
  },
  heroMeta: {
    color: '#cbd5e1',
    fontSize: 14,
    marginTop: 8,
  },
  connectionStatus: {
    fontSize: 13,
    fontWeight: '700',
    marginTop: 8,
  },
  online: {
    color: '#86efac',
  },
  offline: {
    color: '#fca5a5',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  sectionMeta: {
    color: '#94a3b8',
    fontSize: 12,
  },
  roomList: {
    gap: 12,
    paddingRight: 8,
    paddingBottom: 8,
  },
  roomCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
    width: 140,
  },
  roomName: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '700',
  },
  roomStats: {
    color: '#cbd5e1',
    marginTop: 10,
  },
  roomBadge: {
    color: '#86efac',
    marginTop: 8,
    fontWeight: '700',
  },
  widgetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  widgetCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 140,
    minWidth: 130,
  },
  widgetExpanded: {
    flexBasis: 280,
  },
  widgetSummary: {
    flex: 1,
  },
  widgetControls: {
    gap: 12,
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  detailsButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#0f172a',
  },
  widgetDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    marginBottom: 12,
  },
  widgetTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  widgetStatus: {
    color: '#dbeafe',
    marginTop: 6,
    fontWeight: '700',
  },
  widgetRoom: {
    color: '#94a3b8',
    marginTop: 6,
  },
  errorCard: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#fca5a5',
    marginBottom: 18,
  },
  errorTitle: {
    color: '#fca5a5',
    fontWeight: '700',
    marginBottom: 6,
  },
  errorText: {
    color: '#f8fafc',
    marginBottom: 10,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  secondaryButtonText: {
    color: '#f8fafc',
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  scanButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  scanButtonText: {
    color: '#bfdbfe',
    fontWeight: '700',
  },
  discoveryCard: {
    backgroundColor: '#111827',
    borderColor: '#1f2937',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    gap: 8,
  },
  discoveryTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  discoveryRow: {
    color: '#cbd5e1',
    fontSize: 13,
  },
  discoveryDevice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  discoveryDetails: {
    flex: 1,
    gap: 4,
  },
  discoveryHint: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 4,
  },
  addButton: {
    backgroundColor: '#2563eb',
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addButtonText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  addedLabel: {
    color: '#86efac',
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(2, 8, 23, 0.82)',
  },
  pairingModal: {
    gap: 14,
    padding: 20,
    borderRadius: 18,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
  },
  pairingInput: {
    color: '#f8fafc',
    backgroundColor: '#020817',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    padding: 12,
    textAlign: 'center',
    fontSize: 22,
    letterSpacing: 8,
  },
  pairingActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
  },
});
