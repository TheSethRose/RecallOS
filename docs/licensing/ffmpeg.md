# FFmpeg Licensing Strategy

We use LGPL-friendly FFmpeg builds by default via `ffmpeg-static`.

Implications:
- No GPL-only codecs (e.g., libx264, libx265 with certain presets) are bundled by default.
- AAC encoding uses native or LGPL-compatible implementations.
- Users may override FFmpeg path via `FFMPEG_PATH` to point to their own system build (GPL allowed by user choice).

Notes:
- Binary distribution constraints differ by OS. We prefer dynamic download or system override rather than redistributing GPL builds.
- Document any user-provided overrides in release notes if applicable.
