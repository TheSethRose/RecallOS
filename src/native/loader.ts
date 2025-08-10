// T-019: Optional FFI loader (lazy, gated)
import { logWarn } from '../util/log';

export interface FFIHandle {
  available: boolean;
  ffi?: unknown;
  ref?: unknown;
  Struct?: unknown;
  reason?: string;
}

let warnedOnce = false;

export function loadFFI(): FFIHandle {
  if (process.env.RECALLOS_DISABLE_FFI === '1') {
    return { available: false, reason: 'FFI disabled via RECALLOS_DISABLE_FFI=1' };
  }
  try {
    // Dynamic requires inside function scope; do not move to top-level.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffi = require('ffi-napi');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ref = require('ref-napi');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Struct = require('ref-struct-napi');
    return { available: true, ffi, ref, Struct };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const handle: FFIHandle = {
      available: false,
      reason: `Failed to load FFI modules: ${message}`
    };
    if (!warnedOnce && process.env.RECALLOS_USE_FFI === '1') {
      try { logWarn(`FFI requested by RECALLOS_USE_FFI=1 but unavailable: ${message}`); } catch {}
      warnedOnce = true;
    }
    return handle;
  }
}