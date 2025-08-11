# RecallOS — End-to-End To-Do List (Electron + Node.js + FFmpeg + Tesseract + Whisper.cpp)

> Ordered to build logically from zero → MVP → polish → packaging → docs.
> Completion tracked with checkboxes.
> Stable IDs assigned sequentially.

## Phase 0 — Repo, Licensing, and Core Decisions
- [x] [T-001] Create `recallos` monorepo (Electron app using TypeScript; yarn/npm/pnpm—choose one and document)
- [x] [T-002] Choose license (e.g., MIT or Apache-2.0) and add `LICENSE` file
- [x] [T-003] Add `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`
- [x] [T-004] Define Node/Electron versions in `.nvmrc`/`.node-version` and package.json `engines`
- [x] [T-005] Initialize Electron + TypeScript boilerplate (main + renderer processes)
- [x] [T-006] Decide package manager (pnpm recommended for workspace speed) and initialize lockfile
- [x] [T-007] Add ESLint + Prettier configs for consistent formatting
- [x] [T-008] Add Husky + lint-staged for pre-commit checks
- [x] [T-009] Set up GitHub Actions CI matrix (macOS, Windows, Ubuntu) to run build, lint, tests
- [x] [T-010] Add issue templates + PR templates in `.github/`
- [x] [T-011] Create `README.md` with quick-start (clone → install → start)
- [x] [T-012] Add `third_party_licenses.md` and a script to list bundled binary licenses (FFmpeg, Tesseract, Whisper models)
- [x] [T-013] Decide FFmpeg licensing strategy (LGPL vs GPL builds) and document implications

## Phase 1 — Dependencies and Binaries
- [x] [T-014] Add `better-sqlite3` (for SQLite + FTS5) as dependency
- [x] [T-015] Integrate SQLCipher (link against encrypted SQLite); confirm compatibility with `better-sqlite3`
- [x] [T-016] Add FFmpeg binary management (per-OS prebuilt binaries or dynamic download on first run)
- [x] [T-017] Add Tesseract OCR binaries + language data (`eng` by default; allow user to add more)
- [x] [T-018] Add Whisper.cpp binaries; select default model (e.g., `ggml-base.en.bin`); support model folder
- [x] [T-019] Add optional `node-ffi-napi` or native module wrappers if needed for platform APIs
- [x] [T-020] Create a `bin/` manager that resolves correct binary path per-OS and verifies SHA256 checksums
- [x] [T-021] Implement first-run binary presence check + download with progress UI and resume
- [x] [T-022] Add `models/` directory for Whisper models with integrity checks
- [x] [T-023] Add env var overrides to point to system-installed FFmpeg/Tesseract if user prefers

## Phase 2 — Storage & Schema (Encrypted SQLite + FTS5)
- [x] [T-024] Embed/Verify SQLite with FTS5 enabled (runtime detection; FTS objects created when available)
- [x] [T-025] Initialize SQLCipher database with user-provided passphrase (first run) — gated by linkage + RECALLOS_PASSPHRASE
- [x] [T-026] Implement key derivation for SQLCipher with configurable iterations
- [x] [T-027] Create table: `media_chunks(...)`
- [x] [T-028] Create table: `ocr_blocks(...)`
- [x] [T-029] Create table: `transcripts(...)`
- [x] [T-030] Create FTS virtual table: `fts_content(...)` with triggers
- [x] [T-031] Create triggers to auto-insert OCR/transcript text into `fts_content`
- [x] [T-032] Create table: `apps(...)`
- [x] [T-033] Create table: `activity_segments(...)`
- [x] [T-034] Create table: `events(...)`
- [x] [T-035] Create table: `settings(...)`
- [x] [T-036] Create indices and validate query plans
- [x] [T-037] Implement migration system (file-based runner; initial migrations applied on startup)
- [x] [T-038] Define secure IPC channels (main ⇄ renderer) for settings and search
- [x] [T-039] Create background worker for OCR pipeline (stub)
- [x] [T-040] Create background worker for STT pipeline (Whisper.cpp) (stub)
- [x] [T-041] Create background worker for indexing (DB writes, FTS management) (stub)
- [x] [T-042] Implement crash recovery + restart for workers and resumable queues
- [x] [T-043] Add backpressure strategy for capture → OCR/STT queue
- [x] [T-044] Design job schema: `jobs(...)`

## Phase 4 — Permissions & First-Run Setup
- [x] [T-045] Implement macOS Screen Recording permission prompt flow
- [x] [T-046] Implement macOS Microphone permission prompt flow
- [x] [T-047] Add detection and guided setup for system audio
- [x] [T-048] Build a first-run wizard
- [x] [T-049] Add legal/consent notice and per-app opt-in defaults; show active recording indicator
- [x] [T-050] Implement “Pause Recording” and “Pause per-app” quick toggles

## Phase 5 — Capture (Screen + Mic + Optional System Audio)
- [x] [T-051] Implement screen source picker
- [x] [T-052] Build `getDisplayMedia` constraints and connect to preview `<video>`
- [x] [T-053] Pipe screen stream to FFmpeg
- [x] [T-054] Implement chunked recording
- [x] [T-055] Implement microphone capture
- [x] [T-056] Document setup for system audio and allow device selection
- [x] [T-057] Synchronize A/V capture
- [x] [T-058] Validate FFmpeg flags for hardware acceleration
- [x] [T-059] Persist chunk metadata into `media_chunks`
- [x] [T-060] Add auto-rotation/repair for partial chunks on crash
 - [x] [T-205] Capture multiple displays concurrently; tag chunks with display metadata

## Phase 6 — OCR Pipeline (Tesseract)
- [x] [T-061] Decide OCR frequency for performance
- [x] [T-062] Extract frames from each chunk using FFmpeg
- [x] [T-063] Run Tesseract on each frame; capture text, bounding boxes, and confidence
- [x] [T-064] Normalize text and sanitize control characters
- [x] [T-065] Insert OCR results into `ocr_blocks` and `fts_content`
- [x] [T-066] Link OCR record to exact `chunk_id` and `ts_ms`
- [x] [T-067] Add language packs support
- [x] [T-068] Implement retry/backoff for OCR failures and log errors

## Phase 7 — Transcription Pipeline (Whisper.cpp)
- [x] [T-069] Split audio from chunks for transcription
- [x] [T-070] Run Whisper.cpp on each audio chunk; parse SRT
- [x] [T-071] Support “me” vs “others” tagging
- [x] [T-072] Insert transcript lines into `transcripts` and `fts_content`
- [x] [T-073] Expose model selection in settings; ensure/download on apply
- [x] [T-074] Implement GPU acceleration detection (Metal/CUDA/ROCm)
- [x] [T-075] Add diarization toggle if supported
- [x] [T-076] Handle muted segments and silence detection

## Phase 8 — Application & Window Tracking
- [x] [T-077] macOS: Implement app/window tracking via AppleScript
- [x] [T-078] Windows: Implement tracking via Win32 APIs
- [x] [T-079] Linux: Implement tracking for X11 and Wayland
- [x] [T-080] Sample active app/window periodically and merge segments
- [x] [T-081] Write segments into `activity_segments` linked to timespan
- [x] [T-082] Provide mapping UI from executable/bundle → friendly name

## Phase 9 — Calendar Integration
- [x] [T-083] Provide local ICS file import for calendar events — Added ICS import entry point (UI+IPC); staging only. Parsing and de-dupe follow in T-084.
 - [x] [T-084] Parse events into `events` table; de-duplicate
 - [x] [T-085] UI toggle to show calendar overlays on timeline
- [ ] [T-086] Add native calendar integrations (later)

## Phase 10 — Indexing, Search API, and Query UX
- [x] [T-087] Implement simple search API
- [x] [T-088] Support operators in fallback mode
- [x] [T-089] Add filters: by date range, speaker, and content type
- [x] [T-090] Add filters: by app/window
- [x] [T-091] Ranking: prioritize recent hits, window-title matches, and phrases
- [x] [T-092] Add snippet generator around hits (± N seconds; highlight tokens)
- [x] [T-093] Add basic snippet generator (± N characters)
- [x] [T-094] Add pagination for results
- [x] [T-095] Build “jump to moment” action
- [x] [T-096] Add saved searches

- [ ] [T-209] Consolidate snippet generators into a single utility module and update references — merge T-092/T-093 implementations into one

## Phase 11 — Timeline & Playback UI
- [x] [T-097] Basic VS Code–style theming with light/dark switcher
- [ ] [T-098] Implement global search bar with debounced input and shortcuts
- [ ] [T-099] Results list with per-hit metadata
- [ ] [T-100] Timeline scrubber with zoom levels
- [ ] [T-101] Thumbnail strip with hover preview
- [ ] [T-102] Video playback view
- [ ] [T-103] Overlay OCR bounding boxes and transcript captions
- [ ] [T-104] “Copy Text from Moment” panel
- [ ] [T-105] Quick filters: app dropdown, date picker, speaker chips, type toggles
- [ ] [T-106] Indicators for active recording status + privacy pause
- [ ] [T-107] Keyboard navigation: jump hits, change playback speed
- [ ] [T-108] Error UI for missing chunk files

- [ ] [T-210] Scaffold global search bar with debounced input (advances T-098)
- [ ] [T-211] Prototype timeline scrubber (minimal) to satisfy MVP (advances T-100)

## Phase 12 — Settings Window Consolidation
- [x] [T-191] Create dedicated Settings window with tabs (General, Capture, Storage, Calendar, Security, Analytics, Export, Apps)
- [x] [T-192] Move General settings (theme, start on login, privacy indicator)
- [x] [T-193] Move Capture settings (OCR cadence/lang ensure, STT model and threads)
- [x] [T-194] Move Storage settings (data directory selector, retention save/run)
- [x] [T-195] Add Calendar tab scaffolding and wiring (show/hide calendar overlays, ICS import entry point) — aligns with Phase 9
- [x] [T-196] Move Security settings (SQLCipher rekey; disable when unavailable)
- [x] [T-197] Move Analytics settings (telemetry usage/errors; opt-in)
- [x] [T-198] Add Export tools to Settings (backup snapshot; time range export with optional media)
- [x] [T-199] Add Apps tab (per-app capture defaults add/update/remove; app rename UI)
- [x] [T-200] Add “Settings…” entry point in top bar; IPC to open/focus Settings window
- [x] [T-201] Remove legacy settings UI from main page
- [x] [T-202] Update documentation/screenshots to reflect Settings window and tabs
 - [x] [T-203] Externalize Settings scripts and tighten CSP (remove 'unsafe-inline' for scripts; move logic to `src/renderer/settings.js`)
 
- [ ] [T-213] Add CSP audit script to ensure no inline scripts remain after migration (follow-up to T-203)
 

## Phase 13 — Settings & Controls
- [x] [T-109] Theme preference persisted across sessions
- [x] [T-110] Data directory selector
- [x] [T-111] Passphrase change + rekey for SQLCipher
- [x] [T-112] Retention policy settings
- [x] [T-113] Capture toggles and device selectors
- [x] [T-114] OCR cadence and language packs settings
- [x] [T-115] STT model selection and performance presets
- [x] [T-116] App inclusion/exclusion list with enforcement
- [x] [T-117] On-screen privacy indicator always visible
 - [x] [T-118] Backup/export options
- [x] [T-119] Start-on-login and background-minimize options
 - [x] [T-120] Telemetry settings

## Phase 14 — Export & Import Tools
- [x] [T-121] Export search results as JSON/CSV
- [x] [T-122] Export selected time range with related data
- [ ] [T-123] Export “my voice only” dataset
- [ ] [T-124] Export keyframes + OCR text as static HTML snapshot
- [ ] [T-125] Import tool to re-index from exported bundle
- [ ] [T-126] Verify exports preserve encryption status

## Phase 15 — Performance & Reliability
- [ ] [T-127] Implement rolling logs with levels and UI viewer
- [ ] [T-128] Throttle OCR/STT workers based on CPU load
- [ ] [T-129] Use hardware-accelerated decoding/encoding when available
- [ ] [T-130] Add watchdog for queue backlog
- [ ] [T-131] Database VACUUM/ANALYZE schedule
- [ ] [T-132] Fragmentation control for media folder
- [ ] [T-133] Crash-safe writes
- [x] [T-134] Corrupt chunk quarantine
- [x] [T-204] Harden chunk auto-repair: skip `_corrupt` and temp files; quiet ffmpeg logs; normalize errors
- [ ] [T-135] Unit tests for DB access/migrations/queries
- [ ] [T-136] Integration tests across OSes
- [ ] [T-137] Load tests with synthetic data

## Phase 16 — Privacy, Security, and UX Safeguards
- [ ] [T-138] Prominent “Recording Active” indicator
- [ ] [T-139] Global hotkey to pause all capture
- [ ] [T-140] Redaction rules before indexing
- [ ] [T-141] “Do-not-capture” app list defaults
- [ ] [T-142] Encrypt-at-rest verification
- [ ] [T-143] Secure passphrase prompt
- [ ] [T-144] Optional auto-lock after inactivity
- [ ] [T-145] Threat model documentation
- [ ] [T-146] Clear consent language

- [ ] [T-208] Add lint rule/script to prevent logging secrets (e.g., accidental console.log of sensitive data) in production builds
- [ ] [T-214] Write privacy policy markdown summarizing data collection, encryption, and consent language (align with T-146)

## Phase 17 — Cross-Platform Packaging & Distribution
- [ ] [T-147] Configure `electron-builder` targets
- [ ] [T-148] Bundle binaries and models with builds
- [ ] [T-149] Code signing documentation and CI secrets
- [ ] [T-150] Notarization flow for macOS
- [ ] [T-151] App auto-update support
- [ ] [T-152] Minimal system requirements page
- [ ] [T-153] Smoke-test installers on all OSes

- [ ] [T-212] Add `electron-builder` config and CI packaging steps (macOS notarization, Windows signing, Linux targets)

## Phase 18 — Documentation & Onboarding
- [ ] [T-154] Update `README.md` with screenshots/gifs
- [ ] [T-155] Add “Architecture Overview” doc with diagrams
- [ ] [T-156] Write “First Run Guide”
- [ ] [T-157] Write “Troubleshooting” doc
- [ ] [T-158] Write “Performance Tuning” doc
- [ ] [T-159] Write “Privacy & Security” doc
- [ ] [T-160] Write “Developer Guide”
- [ ] [T-161] Write “Releasing” doc
- [ ] [T-162] Add example datasets
- [ ] [T-163] Add issue labels and roadmap board

- [ ] [T-206] Document required native build tools for `better-sqlite3` and SQLCipher in README (macOS/Windows/Linux)
- [ ] [T-207] Document binary download URLs, SHA256 verification, and system-binary fallback for FFmpeg/Tesseract/Whisper

## Phase 19 — Analytics & Activity Statistics
- [ ] [T-164] Build SQL views for activity stats
- [ ] [T-165] Implement simple charts in UI
- [ ] [T-166] Add filters for charts
- [ ] [T-167] Export charts as PNG/CSV

## Phase 20 — Advanced Search & Quality of Life
- [ ] [T-168] Add proximity search
- [ ] [T-169] Add “related moments” suggestions
- [ ] [T-170] Saved search library with pinning
- [ ] [T-171] Keyboard-only power user mode
- [ ] [T-172] Quick in-player text find
- [ ] [T-173] Batch delete by filter

## Phase 21 — Optional Nice-to-Haves
- [ ] [T-174] GPU-accelerated Whisper builds
- [ ] [T-175] Multi-language OCR packs
- [ ] [T-176] Local NAS backup integration
- [ ] [T-177] Plugin hooks
- [ ] [T-178] Cross-device sync

---

## Milestone Breakdown (Suggested)
- [ ] [T-179] M1 (Week 1–2): Repo, binaries, DB schema, simple screen+mic capture → chunk files
- [ ] [T-180] M2 (Week 3–4): OCR+STT workers, indexing, basic search API
- [ ] [T-181] M3 (Week 5–6): Electron UI: search, timeline, playback with overlays
- [ ] [T-182] M4 (Week 7–8): App tracking, settings, retention, exports, privacy guards
- [ ] [T-183] M5 (Week 9–10): Packaging, docs, CI releases, smoke tests on all OSes

---

## Quick “Definition of Done” for MVP
- [ ] [T-184] Launch app, grant permissions, choose data dir, download models
- [ ] [T-185] Record screen+mic, see live recording indicator
- [ ] [T-186] After a few minutes, search any word you saw/said and get results
- [ ] [T-187] Click a result, jump to playback with highlighted overlay and selectable text panel
- [ ] [T-188] Filter by app/window and by speaker (“me”/“others”)
- [ ] [T-189] Database is encrypted; passphrase required on restart; pause/resume works reliably
- [ ] [T-190] Installers for macOS/Windows/Linux produced by CI and verified in fresh VMs

---

## Changelog
<2025-08-11 11:20 America/Chicago> — T-206, T-207, T-208, T-209, T-210, T-211, T-212, T-213, T-214 — Added tasks from report.md to appropriate phases — by maintainer
<2025-08-11 11:05 America/Chicago> — T-205 — Implemented multi-display capture (one MediaRecorder per screen) and persisted display_id/display_name; added DB migration 0005 — by maintainer
<2025-08-11 10:22 America/Chicago> — T-092 — Implemented time-window snippet generator with multi-token highlighting (phrases, words, prefixes) for OCR and transcripts — by maintainer
<2025-08-11 10:15 America/Chicago> — T-119 — Added “Minimize to background on close” setting and main-window interception to honor it — by maintainer
<2025-08-10 14:35 America/Chicago> — T-203, T-204 — Moved inline Settings JS to external file and tightened CSP; improved ffmpeg repair to skip quarantined/temp files and normalized error logging — by maintainer
<2025-08-10 14:47 America/Chicago> — T-084, T-085 — ICS import now parses and upserts events with de-duplication; Calendar overlays toggle wired in Settings — by maintainer