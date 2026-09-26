import { create } from 'zustand';

export type DiscoveryStage = 'idle' | 'searching' | 'found' | 'not-found' | 'offline' | 'disabled';

interface DiscoveryState {
  stage: DiscoveryStage;
  /** Host currently being probed (for UI feedback). */
  probing: string | null;
  host: string | null;
  message: string;
  lastScanAt: number | null;

  set: (patch: Partial<Pick<DiscoveryState, 'stage' | 'probing' | 'host' | 'message' | 'lastScanAt'>>) => void;
}

export const useDiscovery = create<DiscoveryState>((set) => ({
  stage: 'idle',
  probing: null,
  host: null,
  message: 'Not started',
  lastScanAt: null,
  set: (patch) => set(patch),
}));
