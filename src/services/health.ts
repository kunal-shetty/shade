import { api } from './api';
import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';

// ============================================================================
// REST health polling
//
// Device health normally arrives over MQTT `device/health`, but that needs a
// WebSocket-capable broker. Polling the gateway's `/health` gives the app the
// same device + camera state over plain HTTP, so the Camera screen and the
// device list still work when the broker is unavailable.
// ============================================================================

const DEFAULT_INTERVAL_MS = 15_000;

/** One-shot refresh; resolves false when the gateway is unreachable. */
export const pollHealthOnce = async (): Promise<boolean> => {
  const L = useLiveData.getState();
  try {
    const health = await api.deviceHealth();
    L.setDeviceHealth(health);
    // `camera` is published flat by the gateway: "online" | "offline".
    L.setCameraOnline(health.camera === 'online');
    return true;
  } catch {
    L.setCameraOnline(false);
    return false;
  }
};

/** Polls `/health` on an interval. Returns a stop function. */
export const startHealthPolling = (intervalMs = DEFAULT_INTERVAL_MS): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    if (!useSettings.getState().connection.demoMode) await pollHealthOnce();
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};
