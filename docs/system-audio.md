# System Audio Capture Setup

This app can optionally capture system (loopback) audio alongside the microphone.

- macOS: Install a loopback device such as BlackHole (2ch). Select it as the input device in the app when recording system audio. You may also create a Multi-Output Device to hear audio while capturing.
- Windows: Use WASAPI loopback devices. In a future version, you can select the appropriate device in the app.
- Linux: Use PulseAudio monitor sources (e.g., `alsa_output.pci-0000_00_1b.0.analog-stereo.monitor`).

Notes:
- macOS requires Screen Recording permission for display capture and Microphone permission for input capture.
- Ensure you restart the app after granting permissions in System Settings.
