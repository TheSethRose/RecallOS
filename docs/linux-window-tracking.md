# Linux Active App/Window Tracking

This document describes the Linux implementation for active application/window detection used by RecallOS.

Source: [src/native/platform/linux.ts](src/native/platform/linux.ts:1)
Router: [src/native/index.ts](src/native/index.ts:1)
Helper: [src/util/which.ts](src/util/which.ts:1)

Data shape
- The implementation returns the same shape as other platforms:

```typescript
type ActiveAppWindow = {
  pid: number
  title: string
  exe: string
  appId: string
  windowHandle?: string
}
```

Strategy order
- The runtime selects the first available strategy in this order:
  1) X11 via xprop (requires DISPLAY)
  2) Sway/Wayland via swaymsg (requires WAYLAND_DISPLAY)
  3) Hyprland/Wayland via hyprctl (requires WAYLAND_DISPLAY)
- The winning strategy is cached per process to avoid extra spawns each sampling tick.

Environment gating
- X11 is attempted only if DISPLAY is set.
- Wayland strategies are attempted only if WAYLAND_DISPLAY is set.
- Tools are discovered via PATH using which().

Execution and safety
- Uses execFile with argument arrays (no shell), 500 ms timeouts, and bounded 128 KiB buffers.
- Titles and classes are sanitized to strip control characters and truncated to 512 chars.
- Executable path is resolved via /proc/<pid>/exe when pid is known.

Per-strategy notes
- xprop:
  - Reads _NET_ACTIVE_WINDOW from the root window, then queries WM_CLASS, WM_NAME, _NET_WM_PID on the active window id.
  - Derives appId from exe basename, else WM_CLASS, else pid.
- swaymsg:
  - Parses get_tree JSON, finds the focused node by DFS, reads name (title), pid, and app_id/class.
  - Derives appId from exe basename, else app_id/class, else pid.
- hyprctl:
  - Reads activewindow -j JSON, extracts pid, title, and class/initialClass.
  - Derives appId from exe basename, else class, else pid.

Fallback behavior
- If no supported compositor tool is detected, returns { pid: 0, title: '', exe: '', appId: 'unknown' }.
- Logs a single warning: "Linux: No supported compositor tools detected; returning minimal unknown active window info".

Performance considerations
- One process spawn per strategy attempt; the selected strategy is memoized until it fails.
- Short timeouts ensure the sampler is non-blocking.

Verification
- Ensure your environment has either DISPLAY (X11) or WAYLAND_DISPLAY (Wayland).
- Verify tool presence:

```bash
which xprop || true
which swaymsg || true
which hyprctl || true
```

- Quick manual checks:

```bash
xprop -root _NET_ACTIVE_WINDOW
swaymsg -t get_tree | head -c 200
hyprctl activewindow -j | jq .
```

Troubleshooting
- If both DISPLAY and WAYLAND_DISPLAY are unset, only the unknown fallback will be returned.
- If a tool exists but the compositor is different, the strategy will fail fast and move to the next.
- Title may be empty for some apps; appId will still be derived from exe/class/pid.

Integration notes
- Called via platform router: [src/native/index.ts](src/native/index.ts:1) exports getActiveAppWindow() on Linux.
- No new IPC was added; API parity is preserved with Windows/macOS samplers.