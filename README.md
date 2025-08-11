# RecallOS

Electron + Node app. Quick start:

- pnpm install
- pnpm build
- pnpm start

Dev mode:

- pnpm dev

## Optional FFI Layer (T-019)

This repository includes an optional FFI/N-API scaffolding to enable platform APIs on Windows/Linux without adding hard runtime dependencies. It is scaffolding-only and not wired into the application by default.

- Supported platforms: enabled on `win32` and `linux` when available. macOS is excluded by default.
- Lazy loading: FFI modules are required dynamically at call time; there are no top-level imports.
- Optional dependencies: install only if you want to experiment locally.
  - pnpm add ffi-napi ref-napi ref-struct-napi
- Environment flags:
  - RECALLOS_DISABLE_FFI=1 → force-disable with a clear reason.
  - RECALLOS_USE_FFI=1 → force-attempt enable even on unsupported platforms; logs a one-time warning if unavailable.

Minimal usage pattern (guard before use):

```ts
// TypeScript
import { isFFIAvailable, getFFI } from './src/native';

if (isFFIAvailable()) {
  const { ffi, ref, Struct } = getFFI();
  // Use ffi/ref/Struct safely here...
} else {
  // Fallback path when FFI is not available
}
```

Notes:
- The FFI façade and loader live under `src/native/` (lazy, env-gated).
- If RECALLOS_USE_FFI=1 is set but modules are missing, a single warning is logged and execution continues via fallback paths.

## Troubleshooting

- Whisper binary missing or HTTP 401:
	- The macOS first-run downloader uses Homebrew bottles hosted on GHCR, which may rate-limit anonymous downloads. Set a token via env and restart:
		- GHCR_TOKEN=YOUR_TOKEN pnpm start
	- If bottle fails, the app falls back to official whisper.cpp release tarballs.

- better-sqlite3 binding error under Electron:
	- Native module may need to be rebuilt for the current Electron version. You can rebuild locally:
		- pnpm dlx electron-rebuild -f -w better-sqlite3
	- Until rebuilt, the app will continue with a no-op DB stub so UI can load.


## Diarization (experimental) — T-075

- A “Diarization (experimental)” toggle is available in Settings and persists as the `stt_diarization` setting (`on`/`off`).
- Capability is env‑gated. Set `RECALLOS_STT_DIARIZATION_SUPPORTED=1` to enable the control; otherwise the UI is disabled and the backend no‑ops.
- Diarization is not implemented by default; additional components are required.

bash
RECALLOS_STT_DIARIZATION_SUPPORTED=1 pnpm start
## Calendar imports (ICS)

Open Settings → Calendar → Import ICS to stage local calendar files for later processing.

- Supported: .ics files (case-insensitive), up to 10 MB each
- Behavior: Selected files are copied into your app data directory under `calendar/imports`, and a `calendar_import` job is enqueued for each file
- Scope: Import only stages files; parsing/ingestion happens in a later step
- Privacy: All operations are local; no files leave your machine

Verification:
- After import, you should see files in the `imports` folder within your data directory
- The UI will report how many files were imported or if the action was cancelled

Related code:
- Renderer UI: [src/renderer/settings.html](src/renderer/settings.html)
- Renderer typings: [src/renderer/global.d.ts](src/renderer/global.d.ts)
- Preload exposure: [src/main/preload.ts](src/main/preload.ts)
- Main IPC handler: [src/main/main.ts](src/main/main.ts)

## Settings Window (Phase 12)

Open the dedicated Settings window from the main UI (top bar → “Settings…”). Tabs include:

- General: theme, start on login, privacy indicator
- Capture: OCR cadence/lang ensure, STT model and threads
- Storage: data directory, retention save/run
- Calendar: ICS import and show/hide overlays
- Security: SQLCipher rekey (when linked)
- Analytics: opt-in usage/errors
- Export: backup snapshot and time range export with optional media
- Apps: per‑app capture defaults and rename UI

Legacy settings controls were removed from the main page to reduce clutter; use the Settings window for all configuration.