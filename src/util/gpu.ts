import { which } from './which';
import { fileExists } from './file';

export type GpuBackend = 'metal' | 'cuda' | 'rocm' | 'none';

export interface GpuCaps {
  backend: GpuBackend;
  reason?: string;
  bin?: string | null;
}

/**
 * Detect the preferred GPU backend for whisper.cpp at runtime, with env overrides.
 *
 * Env overrides:
 * - RECALLOS_STT_ACCEL=auto|cpu|metal|cuda|rocm
 * - RECALLOS_DISABLE_METAL=1 (darwin only)
 */
export function detectGpuBackend(): GpuCaps {
  // Normalize env override
  const forcedRaw = (process.env.RECALLOS_STT_ACCEL || '').trim().toLowerCase();
  const forced = forcedRaw === 'cpu' ? 'none' : forcedRaw; // alias cpu -> none

  if (forced && ['auto', 'metal', 'cuda', 'rocm', 'none'].includes(forced)) {
    if (forced === 'none') return { backend: 'none', reason: 'forced via RECALLOS_STT_ACCEL=cpu/none' };
    if (forced === 'metal') return { backend: 'metal', reason: 'forced via RECALLOS_STT_ACCEL=metal' };
    if (forced === 'cuda') return { backend: 'cuda', reason: 'forced via RECALLOS_STT_ACCEL=cuda', bin: 'nvidia-smi' };
    if (forced === 'rocm') return { backend: 'rocm', reason: 'forced via RECALLOS_STT_ACCEL=rocm', bin: 'rocminfo' };
    // 'auto' falls through to detection
  }

  // macOS: prefer Metal unless explicitly disabled
  if (process.platform === 'darwin') {
    if (process.env.RECALLOS_DISABLE_METAL === '1') {
      return { backend: 'none', reason: 'Metal disabled via RECALLOS_DISABLE_METAL=1' };
    }
    // Metal is generally available on supported macOS systems; whisper.cpp Metal backend is auto-used with -ngl>0
    return { backend: 'metal', reason: 'darwin platform (Metal assumed)' };
  }

  // CUDA (Windows/Linux): presence of nvidia-smi on PATH is a strong indicator
  const smi = which('nvidia-smi');
  if (smi) {
    return { backend: 'cuda', reason: 'nvidia-smi found on PATH', bin: smi };
  }

  // ROCm/HIP (Linux): look for rocminfo/hipinfo
  const rocminfo = which('rocminfo')
    || which('hipinfo')
    || (fileExists('/opt/rocm/bin/rocminfo') ? '/opt/rocm/bin/rocminfo' : null)
    || (fileExists('/opt/rocm/bin/hipinfo') ? '/opt/rocm/bin/hipinfo' : null);

  if (rocminfo) {
    return { backend: 'rocm', reason: 'ROCm tool found', bin: rocminfo };
  }

  return { backend: 'none', reason: 'no supported GPU tools detected' };
}

/**
 * Conservative defaults for offload layers. These are intentionally modest to avoid OOM.
 * Users can override with RECALLOS_STT_NGL or DB setting 'stt_ngl'.
 */
export function defaultOffloadLayers(backend: GpuBackend): number {
  switch (backend) {
    case 'metal': return 2;   // safe default for integrated GPUs
    case 'cuda':  return 20;  // moderate offload by default
    case 'rocm':  return 12;  // conservative for varied ROCm stacks
    default:      return 0;
  }
}

/**
 * Build whisper.cpp GPU args (-ngl <n>) from detected caps and optional explicit override.
 */
export function whisperGpuArgs(caps: GpuCaps, explicitNgl?: number | null): string[] {
  const envNglRaw = process.env.RECALLOS_STT_NGL;
  const envNgl = envNglRaw != null && envNglRaw !== '' ? Number(envNglRaw) : null;

  const chosen = firstFinite(
    explicitNgl,
    envNgl,
    defaultOffloadLayers(caps.backend)
  );

  if (!Number.isFinite(chosen) || !chosen || chosen <= 0) return [];
  const n = Math.max(0, Math.floor(chosen));
  return n > 0 ? ['-ngl', String(n)] : [];
}

function firstFinite(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}