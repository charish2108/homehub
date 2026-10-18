/** Small shared utilities. */
import * as dgram from 'node:dgram';
import * as dns from 'node:dns/promises';
import * as net from 'node:net';

const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;

export async function withTimeout<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** HTTP helper with timeout; returns parsed JSON or text. */
export async function http(
  url: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  await assertPrivateHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readLimitedResponse(res);
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    async function readLimitedResponse(response: Response): Promise<string> {
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error(`Device response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`);
      }
      if (!response.body) return '';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_HTTP_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error(`Device response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function assertPrivateHost(host: string): Promise<void> {
  if (!host || /[\s/@?#]/.test(host)) throw new Error(`Invalid device host "${host}"`);
  const address = host.replace(/^\[|\]$/g, '');
  if (net.isIP(address)) {
    if (!isPrivateAddress(address)) throw new Error(`Device address must be on a private network: ${host}`);
    return;
  }
  if (!/^(localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(\.local|\.lan)?$/i.test(host)) {
    throw new Error(`Device host must be a private IP or local hostname: ${host}`);
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (cause) {
    throw new Error(`Unable to resolve local device host "${host}": ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!addresses.length || addresses.some(({ address: resolved }) => !isPrivateAddress(resolved))) {
    throw new Error(`Device hostname must resolve only to private addresses: ${host}`);
  }
}

export async function assertPrivateHttpUrl(value: string): Promise<URL> {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error(`Invalid device URL "${value}"`);
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Device URLs must use HTTP(S) and must not contain embedded credentials');
  }
  await assertPrivateHost(target.hostname);
  return target;
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [first, second] = octets;
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first === 127
      || (first === 169 && second === 254);
  }
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/** Send a Wake-on-LAN magic packet to a device MAC (broadcast). */
export async function wakeOnLan(mac: string, broadcast = '255.255.255.255'): Promise<void> {
  const clean = mac.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);
  if (broadcast !== '255.255.255.255') {
    const octets = broadcast.split('.').map(Number);
    if (net.isIP(broadcast) !== 4 || !isPrivateAddress(broadcast) || octets[3] !== 255) {
      throw new Error('Wake-on-LAN broadcast must be the limited broadcast or a private IPv4 subnet broadcast');
    }
  }
  const macBytes = Buffer.from(clean, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)]);
  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 9, broadcast, (err) => {
        socket.close();
        err ? reject(err) : resolve();
      });
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
