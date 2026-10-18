import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  type DeviceInfo,
  type HubSocketEvent,
  connectHubSocket,
  fetchDevices,
  loadHubSettings,
  mergeDeviceUpdate,
  removeDeviceById,
} from '../lib/hub';

export type HubConnectionStatus = 'connecting' | 'connected' | 'offline';

function visibleDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return devices.filter((device) => device.driver !== 'mock' && !device.id.startsWith('demo-'));
}

export function useHubDevices() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [status, setStatus] = useState<HubConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    const settings = await loadHubSettings();
    const nextDevices = await fetchDevices(settings);
    const visible = visibleDevices(nextDevices);
    setDevices(visible);
    return visible;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

      const connect = async () => {
        setStatus('connecting');
        try {
          const settings = await loadHubSettings();
          const initialDevices = await fetchDevices(settings);
          if (!active) return;
          setDevices(visibleDevices(initialDevices));
          setError(null);

          const socket = connectHubSocket(settings, (event: HubSocketEvent) => {
            if (!active) return;
            if (event.type === 'hello' && Array.isArray(event.devices)) {
              setDevices(visibleDevices(event.devices));
              setStatus('connected');
              setError(null);
            } else if (event.type === 'state' && (Array.isArray(event.devices) || event.device)) {
              setDevices((current) => visibleDevices(mergeDeviceUpdate(current, event.devices ?? event.device)));
              setStatus('connected');
              setError(null);
            } else if (event.type === 'device_added' && event.device) {
              setDevices((current) => visibleDevices(mergeDeviceUpdate(current, event.device)));
              setStatus('connected');
              setError(null);
            } else if (event.type === 'device_removed' && event.device) {
              setDevices((current) => removeDeviceById(current, event.device?.id));
              setStatus('connected');
              setError(null);
            }
          });

          socketRef.current = socket;
          socket.onclose = () => {
            if (active && socketRef.current === socket) {
              setStatus('offline');
              setError('Hub connection lost. Reconnecting…');
              reconnectTimer = setTimeout(() => void connect(), 3000);
            }
          };
          socket.onerror = () => {
            if (active && socketRef.current === socket) {
              setStatus('offline');
              setError('Hub connection issue. Retrying…');
            }
          };
        } catch (cause) {
          if (active) {
            setStatus('offline');
            setError(cause instanceof Error ? cause.message : 'Unable to load devices');
            reconnectTimer = setTimeout(() => void connect(), 3000);
          }
        }
      };

      void connect();

      return () => {
        active = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socketRef.current?.close();
        socketRef.current = null;
      };
    }, []),
  );

  return { devices, status, error, refresh };
}
