/** LAN discovery: SSDP (UPnP) + mDNS (Bonjour) sweeps for common smart-device services. */
import * as dgram from 'node:dgram';
import { HubConfig } from './config';
import { DiscoveryResult } from './types';
import { withTimeout } from './util';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

/** mDNS service types worth looking for in a home. */
const MDNS_SERVICES = [
  '_googlecast._tcp.local', // Chromecast / smart displays
  '_samsung._tcp.local', // Samsung TVs
  '_airplay._tcp.local', // Apple-TV-class devices, some TVs
  '_shelly._tcp.local', // Shelly
  '_hap._tcp.local', // HomeKit accessories (incl. Matter bridges)
  '_matter._tcp.local', // Matter devices
  '_philips._tcp.local', // Hue bridges
  '_miid._tcp.local', // Xiaomi
  '_printer._tcp.local', // misc IoT printers sometimes are smart modules
];

const SSDP_SEARCH_TARGETS = [
  'ssdp:all',
  'urn:samsung-com:device:RemoteControlReceiver:1',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:dial-multiscreen-org:service:dial:1',
  'urn:upnp-org:device:InternetGatewayDevice:1',
  'urn:shelly-com:device:shelly:',
];

export async function runDiscovery(cfg: HubConfig['discovery']): Promise<DiscoveryResult[]> {
  const results = new Map<string, DiscoveryResult>();
  const jobs: Promise<void>[] = [];
  if (cfg.ssdp) jobs.push(ssdpSweep(results));
  if (cfg.mdns) jobs.push(mdnsSweep(results));
  await Promise.allSettled(jobs);
  for (const host of cfg.probeHosts) {
    results.set(`probe:${host}`, { id: `probe:${host}`, host, services: [], source: 'probe' });
  }
  return mergeHostResults([...results.values()]);
}

function mergeHostResults(results: DiscoveryResult[]): DiscoveryResult[] {
  const byHost = new Map<string, DiscoveryResult>();
  for (const result of results) {
    const existing = byHost.get(result.host);
    if (!existing) {
      byHost.set(result.host, { ...result, services: [...new Set(result.services)] });
      continue;
    }
    const name = isInformativeName(result.name) ? result.name : existing.name;
    byHost.set(result.host, {
      ...existing,
      id: `host:${result.host}`,
      name,
      services: [...new Set([...existing.services, ...result.services])],
      raw: { ...existing.raw, ...result.raw },
      source: existing.source === result.source ? existing.source : 'ssdp',
    });
  }
  return [...byHost.values()];
}

function isInformativeName(name: string | undefined): boolean {
  return !!name && !/^(linux\/|upnp\/|portable sdk)/i.test(name);
}

function ssdpSweep(results: Map<string, DiscoveryResult>): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8', 0, Math.min(msg.length, 2048));
      if (!text.startsWith('HTTP/1.1 200')) return;
      const headers = parseSsdpHeaders(text);
      const key = `${rinfo.address}:${headers.ST || headers.USN || ''}`;
      if (!results.has(key)) {
        results.set(key, {
          id: key,
          host: rinfo.address,
          name: ssdpDeviceName(headers),
          services: headers.ST ? [headers.ST] : [],
          source: 'ssdp',
          raw: headers,
        });
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      const payload =
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${SSDP_SEARCH_TARGETS.join(',')}\r\n\r\n`;
      // Send one datagram per search target; some stacks ignore comma lists.
      for (const st of SSDP_SEARCH_TARGETS) {
        const msg = payload.replace(`ST: ${SSDP_SEARCH_TARGETS.join(',')}`, `ST: ${st}`);
        socket.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      }
      setTimeout(done, 2600);
    });
  });
}

function ssdpDeviceName(headers: Record<string, string>): string | undefined {
  const evidence = `${headers.FRIENDLYNAME ?? ''} ${headers.USN ?? ''} ${headers.SERVER ?? ''}`.toLowerCase();
  if (evidence.includes('sony') && (evidence.includes('bravia') || evidence.includes('androidtv'))) return 'Sony BRAVIA TV';
  if (evidence.includes('samsung')) return 'Samsung TV';
  if (evidence.includes('webos') || evidence.includes('lge') || evidence.includes('lg electronics')) return 'LG webOS TV';
  if (evidence.includes('shelly')) return 'Shelly device';
  if (evidence.includes('philips') || evidence.includes('hue')) return 'Philips Hue bridge';
  return headers.FRIENDLYNAME || headers.SERVER;
}

function parseSsdpHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function mdnsSweep(results: Map<string, DiscoveryResult>): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen = new Set<string>();
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      try {
        const parsed = parseDnsPacket(msg);
        for (const rec of parsed) {
          if (!rec.ip && !rec.targetHost) continue;
          const key = `${rinfo.address}:${rec.service || rec.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.set(key, {
            id: key,
            host: rec.ip || rinfo.address,
            port: rec.port,
            name: rec.name || rec.service,
            services: rec.service ? [rec.service] : [],
            source: 'mdns',
          });
        }
      } catch {
        /* ignore malformed packets */
      }
    });
    socket.bind(() => {
      try {
        socket.addMembership(MDNS_ADDR);
      } catch {
        /* membership unsupported; queries still go out */
      }
      for (const svc of MDNS_SERVICES) {
        socket.send(buildDnsQuery(svc), MDNS_PORT, MDNS_ADDR, () => {});
      }
      setTimeout(() => {
        // Second pass after cache miss, then close.
        for (const svc of MDNS_SERVICES.slice(0, 4)) {
          socket.send(buildDnsQuery(svc), MDNS_PORT, MDNS_ADDR, () => {});
        }
        setTimeout(done, 1800);
      }, 1800);
    });
  });
}

interface DnsRecord {
  name: string;
  service?: string;
  ip?: string;
  port?: number;
  targetHost?: string;
}

/**
 * Minimal DNS message parser: enough to read PTR/SRV/A/TXT records from mDNS replies.
 */
export function parseDnsPacket(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  if (buf.length > 9000) throw new Error('DNS packet exceeds the mDNS size limit');
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  if (qdcount > 128 || ancount > 512) throw new Error('DNS packet contains too many records');
  let offset = 12;
  const records: DnsRecord[] = [];

  const readName = (start: number): [string, number] => {
    const labels: string[] = [];
    let pos = start;
    let jumped = false;
    let after = -1;
    let nameLength = 0;
    const visited = new Set<number>();
    for (let guard = 0; guard < 128; guard++) {
      if (pos < 0 || pos >= buf.length) throw new Error('DNS name extends beyond packet');
      const len = buf[pos];
      if (len === 0) {
        pos++;
        if (!jumped) after = pos;
        if (after < 0) throw new Error('Invalid DNS name');
        return [labels.join('.'), after];
      }
      if ((len & 0xc0) === 0xc0) {
        if (pos + 1 >= buf.length) throw new Error('Truncated DNS compression pointer');
        const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
        if (ptr >= pos || visited.has(ptr)) throw new Error('Invalid DNS compression pointer');
        visited.add(ptr);
        if (!jumped) after = pos + 2;
        jumped = true;
        pos = ptr;
        continue;
      }
      if ((len & 0xc0) !== 0 || pos + 1 + len > buf.length) throw new Error('Invalid DNS label length');
      const bytes = buf.subarray(pos + 1, pos + 1 + len);
      if ([...bytes].some((byte) => byte < 0x21 || byte > 0x7e || byte === 0x2e)) {
        throw new Error('DNS labels must contain printable ASCII characters');
      }
      nameLength += len + (labels.length ? 1 : 0);
      if (nameLength > 253) throw new Error('DNS name exceeds the maximum length');
      labels.push(bytes.toString('ascii'));
      pos += 1 + len;
      if (!jumped) after = pos;
    }
    throw new Error('DNS compression pointer loop or excessive name depth');
  };

  // Skip questions.
  for (let i = 0; i < qdcount; i++) {
    const [, next] = readName(offset);
    if (next + 4 > buf.length) throw new Error('Truncated DNS question');
    offset = next + 4;
  }

  for (let i = 0; i < ancount; i++) {
    const [name, next] = readName(offset);
    offset = next;
    if (offset + 10 > buf.length) throw new Error('Truncated DNS resource record');
    const type = buf.readUInt16BE(offset);
    const rdlen = buf.readUInt16BE(offset + 8);
    const rdata = offset + 10;
    const rdataEnd = rdata + rdlen;
    if (rdataEnd > buf.length) throw new Error('DNS resource data extends beyond packet');
    offset = rdataEnd;
    const rec: DnsRecord = { name };
    if (type === 12) {
      // PTR: service instance
      const [target, nextTarget] = readName(rdata);
      if (nextTarget > rdataEnd) throw new Error('PTR name extends beyond resource data');
      rec.service = name;
      rec.name = target;
      records.push(rec);
    } else if (type === 33 && rdlen >= 6) {
      // SRV
      rec.port = buf.readUInt16BE(rdata + 4);
      const [target, nextTarget] = readName(rdata + 6);
      if (nextTarget > rdataEnd) throw new Error('SRV name extends beyond resource data');
      rec.targetHost = target;
      records.push(rec);
    } else if (type === 1 && rdlen === 4) {
      rec.ip = `${buf[rdata]}.${buf[rdata + 1]}.${buf[rdata + 2]}.${buf[rdata + 3]}`;
      records.push(rec);
    }
    // TXT (16) intentionally ignored for now.
  }
  return records;
}

/** Build a DNS query packet for a PTR record (single question). */
export function buildDnsQuery(name: string): Buffer {
  const labels = name.split('.').filter(Boolean);
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0].writeUInt16BE(0, 0); // id
  parts[0].writeUInt16BE(0x0000, 2); // standard query
  parts[0].writeUInt16BE(1, 4); // qdcount
  for (const label of labels) {
    const buf = Buffer.alloc(1 + label.length);
    buf.writeUInt8(label.length, 0);
    buf.write(label, 1, 'utf8');
    parts.push(buf);
  }
  parts.push(Buffer.from([0]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(1, 2); // IN
  parts.push(tail);
  return Buffer.concat(parts);
}
