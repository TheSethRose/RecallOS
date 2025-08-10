# RecallOS — Product Requirements Document (Cross-Platform, Electron/Node Version)

## 1. Product Vision
RecallOS is an open-source, privacy-first application that continuously records, indexes, and makes your past screen and audio history fully searchable and replayable — functioning like a personal time machine for your digital life.

In a world where digital information is fleeting, RecallOS lets you instantly find anything you’ve ever seen or heard on your computer, across any app, meeting, or video call — all while keeping your data fully encrypted and entirely on your own device.

---

## 2. Core Features

### Search and Access
- Unified Search — Search your entire history for any word you’ve seen (via screen OCR) or heard (via audio transcription) using an FTS5-powered query on a locally encrypted SQLite database.
- Interactive Time-Travel — Visually scrub through a timeline of your past to see exactly what you were doing at any given moment, with recorded video frames and overlaid OCR/transcript text fetched dynamically.
- Copy Text from Anywhere — Select and copy text from any point in your past, including from videos, images, or shared screens during video calls. The Electron UI renders this as standard selectable text.
- Application-Specific Filtering — Narrow searches to specific applications by filtering the activity log by app/window identifiers.

### Text Recognition and Transcription
- On-Device OCR — All visible text on your screen is made searchable by converting pixels to text with Tesseract OCR (bundled native binary), stored in a dedicated OCR content table.
- On-Device Transcription — Converts everything you say and hear into a searchable, word-by-word transcript using Whisper.cpp (local speech-to-text engine), stored in a transcript table.
- Speaker Detection — Tags microphone input as `"me"` and (optionally) system audio as `"others"`. System audio capture uses platform-specific loopback devices (e.g., BlackHole on macOS, WASAPI on Windows, PulseAudio on Linux).

### Performance and Storage
- Advanced Data Compression — Stores months or years of history using minimal disk space, leveraging FFmpeg chunked recording and compression.
- Efficient Background Operation — Runs quietly using Node.js background processes and OS-level scheduling to perform recording, OCR, and transcription without impacting foreground performance.
- Encrypted Local Database — Stores all metadata, OCR text, and transcripts in a SQLCipher-encrypted SQLite database accessed via the `better-sqlite3` Node binding.
- Organized File Storage — Media files are kept separate from the database:
  - Audio: Compressed `.m4a` or `.wav` snippets in `/media/audio/`
  - Screen recordings: Chunked `.mp4` videos in `/media/video/`

### Privacy and Data Control
- Complete Privacy — All capture, processing, and storage happen locally. No data is sent to any cloud service.
- Voice/Data Export — Export your own data as plain text, JSON, or original audio/video chunks for archival or AI model training.

### Context and Activity Tracking
- Application & Window Tracking — Logs active app and window title with duration via OS APIs:
  - macOS: `applescript` / `system_profiler` queries
  - Windows: Win32 API calls
  - Linux: X11/Wayland queries
- Calendar Integration — Optional: import meetings from local calendar files or APIs for context tagging.
- Activity Statistics — Analytics on active hours, most-used apps, and meeting schedules, generated from the local database.

---

## 3. Architecture Overview

Capture Layer
- Screen Capture: Electron `desktopCapturer` + `navigator.mediaDevices.getUserMedia()` → piped to FFmpeg for encoding into video chunks.
- Audio Capture: `getUserMedia()` for mic; platform loopback device for system audio.
- OCR Engine: Node wrapper for Tesseract OCR.
- Transcription Engine: Node bindings for Whisper.cpp.

Data Layer
- SQLite (FTS5) + SQLCipher for encrypted, full-text searchable storage.
- File-based chunked media storage.

Indexing/Search Layer
- Node-based indexing process pushes OCR and transcript text into SQLite.
- Queries return matched timestamps + context for replay.

UI Layer
- Electron frontend (HTML/CSS/JS or React).
- Search interface with filters.
- Timeline scrubber with thumbnail previews.
- Video player with overlaid OCR/transcript text.

---

## 4. MVP Scope
- Continuous screen and microphone capture (manual start/stop).
- OCR on captured frames (Tesseract).
- Transcription of audio chunks (Whisper.cpp).
- Full-text search (FTS5) in encrypted SQLite database.
- Electron UI with:
  - Search bar + results list
  - Timeline scrubber
  - Playback view with text overlay
- Application tracking (basic app/window title logging).
- Configurable storage directory and data retention limits.

---

## 5. Cross-Platform Notes
- macOS: Screen/mic capture via Electron APIs, system audio via BlackHole.
- Windows: Screen/mic capture via Electron APIs, system audio via WASAPI loopback.
- Linux: Screen/mic capture via Electron APIs, system audio via PulseAudio/PipeWire.

All platforms share:
- FFmpeg for media chunking
- Tesseract for OCR
- Whisper.cpp for transcription
- SQLite + SQLCipher for search/index storage
- Electron for UI

---

## 6. Guiding Principles
- One Tech Stack — Electron + Node.js + native binaries for capture/OCR/STT. One codebase for all OSes.
- One-Shot Build — Contributors should be able to `git clone`, `npm install`, and `npm start` on any OS.
- Privacy by Design — 100% local capture and processing. User data never leaves the machine.
- Readable & Hackable — Clear code structure for easy community contributions.
