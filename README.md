# RecallOS

Electron + Node app. Quick start:

- pnpm install
- pnpm build
- pnpm start

Dev mode:

- pnpm dev

## Troubleshooting

- Whisper binary missing or HTTP 401:
	- The macOS first-run downloader uses Homebrew bottles hosted on GHCR, which may rate-limit anonymous downloads. Set a token via env and restart:
		- GHCR_TOKEN=YOUR_TOKEN pnpm start
	- If bottle fails, the app falls back to official whisper.cpp release tarballs.

- better-sqlite3 binding error under Electron:
	- Native module may need to be rebuilt for the current Electron version. You can rebuild locally:
		- pnpm dlx electron-rebuild -f -w better-sqlite3
	- Until rebuilt, the app will continue with a no-op DB stub so UI can load.
