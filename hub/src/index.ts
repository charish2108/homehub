/** HomeHub entrypoint. */
import { loadConfig, configPath } from './config';
import { Registry } from './registry';
import { createServer } from './server';
import { runDiscovery } from './discovery';
import { DRIVER_NAMES } from './drivers';

async function main(): Promise<void> {
  const { config, createdConfig } = loadConfig();

  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  HomeHub — one app for every appliance        │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  Config : ${configPath()}`);
  if (createdConfig) {
    console.log('  Created a fresh config.json. Discover devices in the app to add appliances.');
  }
  console.log('  Token  : stored in the hub config file');
  console.log(`  Devices: ${config.devices.length} configured`);
  console.log('');

  const registry = new Registry(config.devices);
  await registry.start();

  const { server } = createServer(config, registry);
  server.listen(config.port, config.bind, () => {
    console.log(`  Hub API   : http://${config.bind}:${config.port}/api/devices`);
    console.log(`  WebSocket : ws://${config.bind}:${config.port}/ws`);
    console.log(`  Point the app at this machine's LAN IP, port ${config.port}.`);
    console.log('');
  });

  if (config.discovery.enabled) {
    setTimeout(() => {
      void runDiscovery(config.discovery).then((results) => {
        if (results.length) {
          console.log(`  Discovery found ${results.length} device(s) on the LAN:`);
          for (const r of results) {
            console.log(`    - ${r.host}  [${r.source}]  ${r.services.slice(0, 2).join(', ') || r.name || ''}`);
          }
          console.log('  Add any of these to config.json to control them.');
          console.log('');
        }
      });
    }, 1500);
  }

  const shutdown = async () => {
    console.log('\n  Shutting down...');
    await registry.stop();
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('Hub failed to start:', err);
  process.exit(1);
});

export { DRIVER_NAMES };
