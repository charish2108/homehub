import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import DeviceControls, { isTailoredAction } from '../../components/DeviceControls';
import { useHubDevices } from '../../hooks/useHubDevices';
import { type ActionDef, type ActionParam, loadHubSettings, sendDeviceAction } from '../../lib/hub';

type DraftValue = string | number | boolean;

function getDefaultFieldValue(field: ActionParam): DraftValue {
  if (field.type === 'number') {
    return typeof field.default === 'number' ? field.default : 0;
  }
  if (field.type === 'boolean') {
    return Boolean(field.default);
  }
  if (field.type === 'enum') {
    return field.options?.[0] ?? '';
  }
  return typeof field.default === 'string' ? field.default : '';
}

export default function DeviceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceId = Array.isArray(id) ? id[0] : id;
  const { devices, status, error: connectionError, refresh } = useHubDevices();
  const device = devices.find((item) => item.id === deviceId) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActionDef | null>(null);
  const [draftValues, setDraftValues] = useState<Record<string, DraftValue>>({});

  const summary = useMemo(() => {
    if (!device) return null;
    const s = device.state;

    if (device.class === 'tv') {
      return {
        badge: s.power === false ? 'Off' : s.volume !== undefined ? `${s.volume}% volume` : 'On',
        highlight: s.channel ?? s.input ?? 'TV',
      };
    }

    if (device.class === 'ac') {
      return {
        badge: s.power === false ? 'Off' : `${s.targetTemperature ?? s.currentTemperature ?? 21}°C`,
        highlight: s.mode ?? 'cool',
      };
    }

    if (device.class === 'light') {
      return {
        badge: s.power === false ? 'Off' : `${s.brightness ?? 100}%`,
        highlight: s.colorTemp ? `${(1000000 / Number(s.colorTemp)).toFixed(0)}K` : 'light',
      };
    }

    return {
      badge: s.power === false ? 'Off' : 'On',
      highlight: device.driverLabel,
    };
  }, [device]);

  const triggerAction = useCallback(
    async (name: string, params: Record<string, unknown> = {}): Promise<boolean> => {
      if (!deviceId) return false;
      try {
        setBusyAction(name);
        const settings = await loadHubSettings();
        await sendDeviceAction(settings, deviceId, name, params);
        await refresh();
        setError(null);
        return true;
      } catch (err) {
        setError((err as Error).message || 'Action failed');
        Alert.alert('Action failed', (err as Error).message || 'The action could not be completed.');
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [deviceId, refresh],
  );

  const openAction = useCallback((action: ActionDef) => {
    const initialDraft: Record<string, DraftValue> = {};
    for (const field of action.params ?? []) {
      initialDraft[field.name] = getDefaultFieldValue(field);
    }
    setDraftValues(initialDraft);
    setActiveAction(action);
  }, []);

  const updateDraft = useCallback((field: ActionParam, value: DraftValue) => {
    setDraftValues((prev) => ({ ...prev, [field.name]: value }));
  }, []);

  const submitAction = useCallback(async () => {
    if (!activeAction) return;
    const params: Record<string, unknown> = {};
    for (const field of activeAction.params ?? []) {
      const value = draftValues[field.name];
      params[field.name] = value ?? getDefaultFieldValue(field);
    }

    setActiveAction(null);
    await triggerAction(activeAction.name, params);
  }, [activeAction, draftValues, triggerAction]);

  if (status === 'connecting' && !device) {
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>Loading device…</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>Device not found</Text>
        {error || connectionError ? <Text style={styles.errorText}>{error ?? connectionError}</Text> : null}
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>{device.class}</Text>
        <Text style={styles.heading}>{device.name}</Text>
        <Text style={styles.subtitle}>{device.driverLabel} • {device.room}</Text>
        <Text style={[styles.connectionStatus, device.online ? styles.online : styles.offline]}>
          {device.online ? `Online${status === 'connected' ? ' · live updates' : ''}` : 'Device offline'}
        </Text>

        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>Status</Text>
          <Text style={styles.statusValue}>{summary?.badge ?? 'offline'}</Text>
          <Text style={styles.statusMeta}>{summary?.highlight ?? 'No active data'}</Text>
        </View>

        {error || connectionError ? <Text style={styles.errorText}>{error ?? connectionError}</Text> : null}

        {['tv', 'light', 'ac', 'plug'].includes(device.class) ? (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>{device.class === 'ac' ? 'Climate controls' : `${device.class} controls`}</Text>
            <DeviceControls device={device} onAction={(name, params) => triggerAction(name, params)} busyAction={busyAction} />
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Live state</Text>
          <View style={styles.stateGrid}>
            {device.state.power !== undefined ? <StateChip label="Power" value={device.state.power ? 'On' : 'Off'} /> : null}
            {device.state.volume !== undefined ? <StateChip label="Volume" value={`${device.state.volume}%`} /> : null}
            {device.state.targetTemperature !== undefined ? <StateChip label="Target" value={`${device.state.targetTemperature}°C`} /> : null}
            {device.state.currentTemperature !== undefined ? <StateChip label="Current" value={`${device.state.currentTemperature}°C`} /> : null}
            {device.state.mode ? <StateChip label="Mode" value={device.state.mode} /> : null}
            {device.state.brightness !== undefined ? <StateChip label="Brightness" value={`${device.state.brightness}%`} /> : null}
            {device.state.channel ? <StateChip label="Channel" value={device.state.channel} /> : null}
            {device.state.input ? <StateChip label="Input" value={device.state.input} /> : null}
          </View>
        </View>

        {device.actions.some((action) => !isTailoredAction(device.class, action.name)) ? (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>{['tv', 'light', 'ac', 'plug'].includes(device.class) ? 'More actions' : 'Actions'}</Text>
            <View style={styles.actionGrid}>
              {device.actions.filter((action) => !isTailoredAction(device.class, action.name)).map((action) => (
                <Pressable
                  key={action.name}
                  onPress={() => openAction(action)}
                  disabled={busyAction === action.name}
                  style={[styles.actionButton, busyAction === action.name && styles.actionButtonDisabled]}
                >
                  <Text style={styles.actionText}>{busyAction === action.name ? 'Working…' : action.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <Modal transparent visible={!!activeAction} animationType="slide" onRequestClose={() => setActiveAction(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{activeAction?.label ?? 'Action'}</Text>

            <ScrollView style={styles.modalFields} keyboardShouldPersistTaps="handled">
              {(activeAction?.params ?? []).map((field) => {
                const value = draftValues[field.name] ?? getDefaultFieldValue(field);

                return (
                  <View key={field.name} style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>{field.label ?? field.name}</Text>

                    {field.type === 'number' ? (
                      <TextInput
                        style={styles.input}
                        keyboardType="numeric"
                        value={String(value)}
                        onChangeText={(text) => updateDraft(field, Number(text) || 0)}
                      />
                    ) : null}

                    {field.type === 'string' ? (
                      <TextInput
                        style={styles.input}
                        value={String(value ?? '')}
                        onChangeText={(text) => updateDraft(field, text)}
                      />
                    ) : null}

                    {field.type === 'boolean' ? (
                      <Pressable style={styles.toggleRow} onPress={() => updateDraft(field, !Boolean(value))}>
                        <Text style={styles.toggleText}>{Boolean(value) ? 'Enabled' : 'Disabled'}</Text>
                      </Pressable>
                    ) : null}

                    {field.type === 'enum' && field.options?.length ? (
                      <View style={styles.enumList}>
                        {field.options.map((option) => (
                          <Pressable
                            key={option}
                            onPress={() => updateDraft(field, option)}
                            style={[styles.enumOption, value === option && styles.enumOptionSelected]}
                          >
                            <Text style={[styles.enumOptionText, value === option && styles.enumOptionTextSelected]}>{option}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable onPress={() => setActiveAction(null)} style={styles.secondaryButton}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void submitAction()} style={styles.primaryButton}>
                <Text style={styles.primaryText}>Send</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function StateChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stateChip}>
      <Text style={styles.stateChipLabel}>{label}</Text>
      <Text style={styles.stateChipValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0f172a',
    padding: 20,
    paddingBottom: 40,
  },
  eyebrow: {
    color: '#93c5fd',
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  heading: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 6,
  },
  subtitle: {
    color: '#cbd5e1',
    fontSize: 15,
    marginBottom: 18,
  },
  connectionStatus: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 16,
  },
  online: {
    color: '#86efac',
  },
  offline: {
    color: '#fca5a5',
  },
  statusCard: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1f2937',
    marginBottom: 20,
  },
  statusLabel: {
    color: '#94a3b8',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  statusValue: {
    color: '#f8fafc',
    fontSize: 32,
    fontWeight: '800',
    marginTop: 8,
  },
  statusMeta: {
    color: '#cbd5e1',
    marginTop: 6,
  },
  sectionCard: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1f2937',
    marginBottom: 18,
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  stateGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  stateChip: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 90,
  },
  stateChipLabel: {
    color: '#94a3b8',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  stateChipValue: {
    color: '#f8fafc',
    fontWeight: '700',
    marginTop: 4,
  },
  actionGrid: {
    gap: 10,
  },
  actionButton: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  actionText: {
    color: '#f8fafc',
    fontWeight: '700',
    textAlign: 'center',
  },
  errorText: {
    color: '#fca5a5',
    marginTop: 10,
    marginBottom: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#111827',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1f2937',
    maxHeight: '90%',
  },
  modalFields: {
    flexShrink: 1,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 16,
  },
  fieldBlock: {
    marginBottom: 16,
  },
  fieldLabel: {
    color: '#cbd5e1',
    marginBottom: 8,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleRow: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  toggleText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  enumList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  enumOption: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  enumOptionSelected: {
    backgroundColor: '#1d4ed8',
    borderColor: '#93c5fd',
  },
  enumOptionText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  enumOptionTextSelected: {
    color: '#f8fafc',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#1f2937',
  },
  secondaryText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  primaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#2563eb',
  },
  primaryText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
});
