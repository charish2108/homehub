import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import type { DeviceClass, DeviceInfo } from '../lib/hub';

interface DeviceControlsProps {
  device: DeviceInfo;
  onAction: (name: string, params?: Record<string, unknown>) => void | boolean | Promise<void | boolean>;
  busyAction?: string | null;
}

const tailoredActions: Record<DeviceClass, readonly string[]> = {
  tv: ['power_on', 'power_off', 'toggle_power', 'remote_key', 'launch_app', 'volume_set', 'volume_up', 'volume_down', 'mute_toggle'],
  light: ['power_on', 'power_off', 'toggle_power', 'brightness_set'],
  ac: ['power_on', 'power_off', 'toggle_power', 'temperature_set', 'temperature_up', 'temperature_down', 'mode_set', 'fan_set', 'swing_toggle'],
  plug: ['power_on', 'power_off', 'toggle_power'],
  washer: [],
  dryer: [],
  fridge: [],
  speaker: [],
  vacuum: [],
  other: [],
};

export function isTailoredAction(deviceClass: DeviceClass, actionName: string): boolean {
  return tailoredActions[deviceClass].includes(actionName);
}

const STREAMING_APPS = [
  { id: 'netflix', label: 'Netflix', mark: 'N', color: '#e50914', textColor: '#fff' },
  { id: 'prime_video', label: 'Prime Video', mark: 'prime', color: '#142b43', textColor: '#54c8f5' },
  { id: 'hotstar', label: 'Hotstar', mark: '✦', color: '#17133b', textColor: '#a78bfa' },
  { id: 'youtube', label: 'YouTube', mark: '▶', color: '#ff0033', textColor: '#fff' },
] as const;

export default function DeviceControls({ device, onAction, busyAction }: DeviceControlsProps) {
  const [inputsExpanded, setInputsExpanded] = useState(false);
  const actions = new Map(device.actions.map((action) => [action.name, action]));
  const actionNames = new Set(actions.keys());
  const remoteKeys = new Set(actions.get('remote_key')?.params?.find((param) => param.name === 'key')?.options ?? []);
  const state = device.state;
  const tvPowered = state.power !== false;

  const power = () => {
    const turnOn = !tvPowered;
    const explicitAction = turnOn ? 'power_on' : 'power_off';
    const actionName = actionNames.has(explicitAction) ? explicitAction : 'toggle_power';
    const label = actionName === 'toggle_power' && typeof state.power !== 'boolean'
      ? 'Toggle power'
      : turnOn
        ? 'Power on'
        : 'Power off';
    return button('⏻', actionName, undefined, false, label);
  };

  const button = (
    label: string,
    action: string,
    params?: Record<string, unknown>,
    disabled = false,
    accessibilityLabel = label,
    onPress?: () => void | Promise<void>,
  ) => {
    if (!actionNames.has(action)) return null;
    const isDisabled = disabled || busyAction === action;
    return (
      <Pressable
        key={`${action}-${label}`}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={isDisabled}
        onPress={() => onPress ? void onPress() : void onAction(action, params)}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.pressed,
          isDisabled && styles.disabled,
        ]}
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    );
  };

  const controls = (() => {
    switch (device.class) {
      case 'tv': {
        const remoteKey = (key: string, label = key, accessibilityLabel = label) => remoteKeys.has(key)
          ? button(label, 'remote_key', { key }, false, accessibilityLabel)
          : null;
        return (
          <>
            <View style={styles.row}>
              {power()}
              {tvPowered ? button('🔇', 'mute_toggle') ?? remoteKey('MUTE', '🔇') : null}
            </View>
            {tvPowered && remoteKeys.size ? (
              <View style={styles.remote}>
                {remoteKey('HOME', '⌂')}
                <View style={styles.remoteRow}>
                  {remoteKey('UP', '▲')}
                </View>
                <View style={styles.remoteRow}>
                  {remoteKey('LEFT', '◀')}
                  {remoteKey('ENTER', 'OK')}
                  {remoteKey('RIGHT', '▶')}
                </View>
                <View style={styles.remoteRow}>
                  {remoteKey('DOWN', '▼')}
                </View>
                <View style={styles.row}>
                  {remoteKey('BACK', '↩')}
                  {remoteKey('MENU', '☰')}
                  {remoteKey('SETTINGS', '⚙')}
                </View>
                <View style={styles.row}>
                  {remoteKey('PLAY', '▶')}
                  {remoteKey('PAUSE', 'Ⅱ')}
                  {remoteKey('PLAY_PAUSE', '▶Ⅱ')}
                  {remoteKey('STOP', '■')}
                  {remoteKey('REWIND', '≪')}
                  {remoteKey('FAST_FORWARD', '≫')}
                </View>
                <View style={styles.row}>
                  {remoteKey('CHANNEL_DOWN', 'CH −')}
                  {remoteKey('CHANNEL_UP', 'CH +')}
                </View>
              </View>
            ) : null}
            {tvPowered && remoteKeys.size ? (
              <View style={styles.inputSection}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show input options"
                  accessibilityState={{ expanded: inputsExpanded }}
                  onPress={() => setInputsExpanded((expanded) => !expanded)}
                  style={({ pressed }) => [styles.inputToggle, pressed && styles.pressed]}
                >
                  <Text style={styles.buttonText}>{inputsExpanded ? '▣ Hide inputs' : '▣ Inputs'}</Text>
                </Pressable>
                {inputsExpanded ? <View style={styles.row}>
                  {remoteKey('SOURCE', '▣', 'Open input menu')}
                  {remoteKey('HDMI_1', 'HDMI 1', 'Switch to HDMI 1')}
                  {remoteKey('HDMI_2', 'HDMI 2', 'Switch to HDMI 2')}
                  {remoteKey('HDMI_3', 'HDMI 3', 'Switch to HDMI 3')}
                  {remoteKey('HDMI_4', 'HDMI 4', 'Switch to HDMI 4')}
                </View> : null}
              </View>
            ) : null}
            {tvPowered ? <View style={styles.row}>
              {button('🔉 −', actionNames.has('volume_down') ? 'volume_down' : 'volume_set', actionNames.has('volume_down') ? undefined : { value: Math.max(0, (state.volume ?? 0) - 5) }) ?? remoteKey('VOLUME_DOWN', '🔉 −')}
              {button('🔊 +', actionNames.has('volume_up') ? 'volume_up' : 'volume_set', actionNames.has('volume_up') ? undefined : { value: Math.min(100, (state.volume ?? 0) + 5) }) ?? remoteKey('VOLUME_UP', '🔊 +')}
            </View> : null}
            {tvPowered ? <Text style={styles.readout}>{state.volume === undefined ? 'Volume unavailable' : `Volume ${state.volume}%`}</Text> : null}
            {tvPowered && actionNames.has('launch_app') ? (
              <View style={styles.appSection}>
                <Text style={styles.appSectionTitle}>Applications</Text>
                <View style={styles.appGrid}>
                {STREAMING_APPS.map((app) => (
                  <Pressable
                    key={app.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${app.label}`}
                    accessibilityHint={`Launch ${app.label} on the TV`}
                    disabled={busyAction === 'launch_app'}
                    onPress={() => onAction('launch_app', { app: app.id })}
                    style={({ pressed }) => [
                      styles.appButton,
                      { backgroundColor: app.color },
                      pressed && styles.pressed,
                      busyAction === 'launch_app' && styles.disabled,
                    ]}
                  >
                    <Text style={[
                      styles.appMark,
                      { color: app.textColor },
                      app.id === 'netflix' && styles.netflixMark,
                      app.id === 'youtube' && styles.youtubeMark,
                    ]}>
                      {app.mark}
                    </Text>
                    <Text style={[styles.appLabel, { color: app.textColor }]}>{app.label}</Text>
                  </Pressable>
                ))}
                </View>
              </View>
            ) : null}
          </>
        );
      }
      case 'light':
        return (
          <>
            <View style={styles.row}>{power()}</View>
            <Text style={styles.readout}>{state.brightness === undefined ? 'Brightness unavailable' : `Brightness ${state.brightness}%`}</Text>
            <View style={styles.row}>
              {button('Dim', 'brightness_set', { value: Math.max(0, (state.brightness ?? 100) - 10) })}
              {button('Brighter', 'brightness_set', { value: Math.min(100, (state.brightness ?? 0) + 10) })}
            </View>
          </>
        );
      case 'ac': {
        const modeOptions = device.actions.find((action) => action.name === 'mode_set')?.params?.find((param) => param.name === 'value')?.options ?? [];
        const temperature = state.targetTemperature ?? 24;
        return (
          <>
            <View style={styles.row}>
              {power()}
              {button('−1°', 'temperature_set', { value: Math.max(16, temperature - 1) })}
              {button('+1°', 'temperature_set', { value: Math.min(30, temperature + 1) })}
            </View>
            <Text style={styles.temperature}>{state.targetTemperature === undefined ? '—' : `${state.targetTemperature}°C`}</Text>
            {modeOptions.length ? (
              <View style={styles.row}>
                {modeOptions.map((mode) => (
                  <Pressable
                    key={mode}
                    accessibilityRole="button"
                    accessibilityState={{ selected: state.mode === mode }}
                    onPress={() => onAction('mode_set', { value: mode })}
                    disabled={busyAction === 'mode_set'}
                    style={[
                      styles.modeButton,
                      state.mode === mode && styles.modeSelected,
                      busyAction === 'mode_set' && styles.disabled,
                    ]}
                  >
                    <Text style={styles.buttonText}>{mode}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {button(`Fan: ${state.fan ?? 'auto'}`, 'fan_set', {
              value: state.fan === 'high' ? 'auto' : state.fan === 'auto' ? 'low' : state.fan === 'low' ? 'medium' : 'high',
            })}
            {button(`Swing: ${state.swing ? 'On' : 'Off'}`, 'swing_toggle')}
          </>
        );
      }
      case 'plug':
        return (
          <View style={styles.row}>
            {power()}
          </View>
        );
      default:
        return null;
    }
  })();

  if (!controls) return null;
  return <View style={styles.panel}>{controls}</View>;
}

const styles = StyleSheet.create({
  panel: {
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  remote: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  remoteRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  appSection: {
    gap: 8,
    marginTop: 8,
  },
  inputSection: {
    gap: 8,
    marginTop: 8,
  },
  inputToggle: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  appSectionTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  appGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  appButton: {
    width: 92,
    minHeight: 54,
    paddingHorizontal: 8,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: 7,
  },
  appMark: {
    fontSize: 20,
    fontWeight: '900',
  },
  netflixMark: {
    fontSize: 30,
    fontFamily: 'serif',
  },
  youtubeMark: {
    width: 24,
    height: 17,
    borderRadius: 5,
    backgroundColor: '#fff',
    color: '#ff0033',
    fontSize: 12,
    textAlign: 'center',
    overflow: 'hidden',
  },
  appLabel: {
    flexShrink: 1,
    fontSize: 10,
    fontWeight: '700',
  },
  button: {
    minWidth: 76,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#1d4ed8',
  },
  modeButton: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  modeSelected: {
    backgroundColor: '#1d4ed8',
    borderColor: '#93c5fd',
  },
  buttonText: {
    color: '#f8fafc',
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.94 }],
  },
  readout: {
    color: '#cbd5e1',
    fontWeight: '600',
  },
  temperature: {
    color: '#f8fafc',
    fontSize: 38,
    fontWeight: '800',
    textAlign: 'center',
  },
});
