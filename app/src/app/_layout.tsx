import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#111827' },
          headerTintColor: '#f9fafb',
          contentStyle: { backgroundColor: '#0f172a' },
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
    </>
  );
}
