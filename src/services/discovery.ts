import * as Network from 'expo-network';
import { useSettings } from '../store/settings';
import { useDiscovery } from '../store/discovery';

// ============================================================================
// Zero-config Pi discovery
//
// Requirement: the phone and the Pi only have to be on the same WiFi.
// Order of attack:
//   1. the host currently saved in Settings (fast path after a first success)
//   2. the Pi's mDNS name (Avahi publishes `cybersentinel.local`)
//   3. a bounded parallel scan of the phone's own /24 subnet on the API port
// ============================================================================

const PROBE_TIMEOUT_MS = 1200;
const SCAN_TIMEOUT_MS = 450;
const SCAN_CONCURRENCY = 32;

export const MDNS_HOST = 'cybersentinel.local';

interface HealthBody {
  status?: string;
  service?: string;
}

/** Single `/health` probe. Resolves true only for a CyberSentinel gateway. */
export const probeHost = async (host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> => {
  if (!host) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as HealthBody | null;
    return !!body && (body.status === 'online' || body.service === 'cybersentinel');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** `192.168.0.115` -> `192.168.0`; anything that is not a plain IPv4 -> null. */
const subnetOf = (ip: string | null | undefined): string | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((ip ?? '').trim());
  if (!m) return null;
  const octets = [m[1], m[2], m[3]];
  if (octets.some((o) => Number(o) > 255)) return null;
  return octets.join('.');
};

const scanSubnet = async (base: string, port: number, onProbe?: (host: string) => void, skip?: string): Promise<string | null> => {
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i += 1) {
    const host = `${base}.${i}`;
    if (host !== skip) hosts.push(host);
  }

  let cursor = 0;
  let found: string | null = null;

  const worker = async () => {
    while (cursor < hosts.length && found === null) {
      const host = hosts[cursor];
      cursor += 1;
      onProbe?.(host);
      if (await probeHost(host, port, SCAN_TIMEOUT_MS)) {
        found = host;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return found;
};

let inFlight: Promise<string | null> | null = null;
let lastGoodHost: string | null = null;

export const getLastGoodHost = (): string | null => lastGoodHost;

/**
 * Resolve the Pi's address. Returns the host (without port) or null when the
 * Pi cannot be found on the current network.
 */
export const discoverPi = async (opts: { deep?: boolean } = {}): Promise<string | null> => {
  const { connection, setConnection } = useSettings.getState();
  const D = useDiscovery.getState();

  if (connection.demoMode) {
    D.set({ stage: 'disabled', message: 'Demo mode — no hardware lookup' });
    return null;
  }
  if (!connection.autoDiscover) {
    D.set({ stage: 'disabled', host: connection.host, message: 'Manual address' });
    return connection.host;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    D.set({ stage: 'searching', probing: null, message: 'Looking for the rover…', lastScanAt: Date.now() });

    // Only a definitively-offline phone aborts the search. The reported TYPE is
    // not a trustworthy gate: a VPN reports VPN, and a lab WiFi with no internet
    // access (plus mobile data switched on) reports CELLULAR — which is exactly
    // the case that used to stop discovery dead with "Connect to the same WiFi
    // as the Pi" while the phone was on that WiFi the whole time, leaving the
    // app dialling an mDNS name Android cannot resolve.
    const state = await Network.getNetworkStateAsync().catch(() => null);
    if (state?.isConnected === false) {
      D.set({ stage: 'offline', message: 'No network connection on the phone', lastScanAt: Date.now() });
      return null;
    }

    const candidates = dedupe([
      lastGoodHost,
      connection.host,
      connection.hostname,
      MDNS_HOST,
    ]);

    for (const host of candidates) {
      D.set({ probing: host, message: `Trying ${host}…` });
      if (await probeHost(host, connection.apiPort)) {
        lastGoodHost = host;
        if (host !== connection.host) setConnection({ host });
        D.set({ stage: 'found', host, probing: null, message: `Found rover at ${host}`, lastScanAt: Date.now() });
        return host;
      }
    }

    // Fall back to scanning the local subnet, unless the caller only wants a
    // quick check (e.g. a periodic light retry).
    if (opts.deep) {
      let ownIp = '';
      try {
        ownIp = await Network.getIpAddressAsync();
      } catch {
        ownIp = '';
      }
      // A VPN hands back its own address, which sits on no LAN the rover is on,
      // so the address the Pi was last reached at is just as good a lead.
      const subnets = dedupe([subnetOf(ownIp), subnetOf(connection.host), subnetOf(connection.hostname)]);
      for (const subnet of subnets) {
        D.set({ message: `Scanning ${subnet}.0/24…` });
        const found = await scanSubnet(subnet, connection.apiPort, (host) => D.set({ probing: host }), ownIp);
        if (found) {
          lastGoodHost = found;
          if (found !== connection.host) setConnection({ host: found });
          D.set({ stage: 'found', host: found, probing: null, message: `Found rover at ${found}`, lastScanAt: Date.now() });
          return found;
        }
      }
    }

    D.set({ stage: 'not-found', probing: null, message: 'Rover not found on this network', lastScanAt: Date.now() });
    return null;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
};

const dedupe = (values: (string | null | undefined)[]): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

let unsubscribe: { remove: () => void } | null = null;

/**
 * Watches for WiFi changes and re-runs discovery. `onResolved` fires with the
 * host so the caller can (re)connect its links.
 */
export const startAutoDiscovery = async (onResolved: (host: string) => void): Promise<() => void> => {
  const first = await discoverPi({ deep: true });
  if (first) onResolved(first);

  try {
    unsubscribe = Network.addNetworkStateListener((state) => {
      if (state.type !== Network.NetworkStateType.WIFI && state.type !== Network.NetworkStateType.ETHERNET) return;
      if (!useSettings.getState().connection.autoDiscover) return;
      if (useSettings.getState().connection.demoMode) return;
      // Network changed — check the quick paths, then do a full scan.
      void discoverPi({ deep: true }).then((host) => {
        if (host) onResolved(host);
      });
    });
  } catch {
    unsubscribe = null;
  }

  return () => {
    unsubscribe?.remove();
    unsubscribe = null;
  };
};

/** Convenience for settings/debug UIs. */
export const getDiscoverySnapshot = () => useDiscovery.getState();
