// T-019: FFI facade and platform gating (scaffolding only)
import { loadFFI, type FFIHandle } from './loader';

export interface FFIAccess {
  enabled: boolean;
  reason?: string;
}

// T-078: Common shape for active app/window sampling across platforms
export type ActiveAppWindow = {
  pid: number;
  title: string;
  exe: string;
  appId: string;
  windowHandle?: number;
};

function platformEligible(): boolean {
  return process.platform === 'win32' || process.platform === 'linux';
}

export function shouldEnableFFI(): FFIAccess {
  if (process.env.RECALLOS_DISABLE_FFI === '1') {
    return { enabled: false, reason: 'FFI disabled via RECALLOS_DISABLE_FFI=1' };
  }
  if (process.env.RECALLOS_USE_FFI === '1') {
    return { enabled: true };
  }
  const eligible = platformEligible();
  return {
    enabled: eligible,
    reason: eligible ? undefined : 'Unsupported platform for FFI (enable with RECALLOS_USE_FFI=1)'
  };
}

export function getFFI(): FFIHandle {
  const gate = shouldEnableFFI();
  if (!gate.enabled) {
    return { available: false, reason: gate.reason ?? 'FFI not enabled' };
  }
  return loadFFI();
}

export function isFFIAvailable(): boolean {
  const gate = shouldEnableFFI();
  if (!gate.enabled) return false;
  const handle = loadFFI();
  return !!handle.available;
}

export async function getActiveAppWindow(): Promise<ActiveAppWindow> {
  if (process.platform === 'win32') {
    const mod = await import('./platform/win32');
    return mod.getActiveAppWindow();
  }
  if (process.platform === 'linux') {
    const mod = await import('./platform/linux');
    return mod.getActiveAppWindow();
  }
  // Non-Windows/Linux platforms are handled elsewhere (e.g., macOS via AppleScript in main).
  return { pid: 0, title: '', exe: '', appId: 'unknown' };
}