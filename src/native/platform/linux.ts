// T-079: Linux active app/window tracking — Wayland/X11 (xprop/swaymsg/hyprctl) with safe fallback
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import { which } from '../../util/which';
import { logWarn } from '../../util/log';
import type { ActiveAppWindow } from '../index';

const execFileAsync = promisify(execFile);

// Warn only once when falling back to unknown
let warnedUnknownOnce = false;

function sanitize(s: string): string {
  return String(s || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 512);
}

function isX11(): boolean {
  return !!process.env.DISPLAY;
}

function isWayland(): boolean {
  return !!process.env.WAYLAND_DISPLAY;
}

async function resolveExeFromPid(pid: number): Promise<string> {
  if (!pid || !Number.isFinite(pid)) return '';
  try {
    const p = `/proc/${pid}/exe`;
    const link = await fsp.readlink(p);
    return String(link || '');
  } catch {
    return '';
  }
}

async function run(cmd: string, args: string[], timeoutMs = 500): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 128 * 1024,
  });
  return String(stdout || '').trim();
}

// Hyprland: hyprctl activewindow -j
async function tryHyprland(): Promise<ActiveAppWindow | null> {
  if (!isWayland()) return null;
  const bin = which('hyprctl');
  if (!bin) return null;
  try {
    const out = await run(bin, ['activewindow', '-j']);
    if (!out) return null;
    const obj = JSON.parse(out || '{}') as any;
    const pid = Number(obj?.pid || 0) || 0;
    const title = sanitize(obj?.title || obj?.initialTitle || '');
    const clsRaw = obj?.class || obj?.initialClass || '';
    const cls = sanitize(String(clsRaw || ''));
    if (!pid && !title) return null;
    const exe = await resolveExeFromPid(pid);
    const appId = (exe ? basename(exe) : cls || (pid ? `pid:${pid}` : '')).toLowerCase() || 'unknown';
    return { pid, title, exe, appId };
  } catch {
    return null;
  }
}

// Sway/Wayland: swaymsg -t get_tree → find focused node
function findFocusedSwayNode(node: any): any | null {
  if (!node || typeof node !== 'object') return null;
  if (node.focused) return node;
  const kids = ([] as any[]).concat(node.nodes || [], node.floating_nodes || []);
  for (const k of kids) {
    const res = findFocusedSwayNode(k);
    if (res) return res;
  }
  return null;
}
async function trySway(): Promise<ActiveAppWindow | null> {
  if (!isWayland()) return null;
  const bin = which('swaymsg');
  if (!bin) return null;
  try {
    const out = await run(bin, ['-t', 'get_tree']);
    if (!out) return null;
    const tree = JSON.parse(out);
    const focused = findFocusedSwayNode(tree);
    if (!focused) return null;
    const pid = Number(focused.pid || 0) || 0;
    const title = sanitize(focused.name || '');
    const app = sanitize(String(focused.app_id || focused.window_properties?.class || ''));
    if (!pid && !title) return null;
    const exe = await resolveExeFromPid(pid);
    const appId = (exe ? basename(exe) : app || (pid ? `pid:${pid}` : '')).toLowerCase() || 'unknown';
    return { pid, title, exe, appId };
  } catch {
    return null;
  }
}

// X11 userland: xprop (DISPLAY required)
async function tryXProp(): Promise<ActiveAppWindow | null> {
  if (!isX11()) return null;
  const bin = which('xprop');
  if (!bin) return null;
  try {
    const root = await run(bin, ['-root', '_NET_ACTIVE_WINDOW']);
    const m = root.match(/(0x[0-9a-fA-F]+)/);
    if (!m) return null;
    const wid = m[1];
    // Query all needed props in one call to minimize process spawns
    const out = await run(bin, ['-id', wid, 'WM_CLASS', 'WM_NAME', '_NET_WM_PID']);

    let pid = 0;
    let title = '';
    let wmClass = '';

    for (const line of out.split(/\r?\n/)) {
      if (line.includes('_NET_WM_PID')) {
        const pm = line.match(/=\s*(\d+)/);
        if (pm) pid = Number(pm[1]) || 0;
      } else if (line.startsWith('WM_NAME(') || line.startsWith('WM_NAME ')) {
        const tm = line.match(/=\s*"(.*)"\s*$/);
        if (tm) title = sanitize(tm[1]);
      } else if (line.startsWith('WM_CLASS(') || line.startsWith('WM_CLASS ')) {
        // Typically: WM_CLASS(STRING) = "google-chrome", "Google-chrome"
        const cm = line.match(/=\s*"(.*)"\s*,\s*"(.*)"\s*$/);
        if (cm) {
          const instance = sanitize(cm[1]);
          const cls = sanitize(cm[2]);
          wmClass = cls || instance || '';
        } else {
          const single = line.match(/=\s*"(.*)"\s*$/);
          if (single) wmClass = sanitize(single[1]);
        }
      }
    }

    if (!pid && !title && !wmClass) return null;
    const exe = await resolveExeFromPid(pid);
    const appId = (exe ? basename(exe) : wmClass || (pid ? `pid:${pid}` : '')).toLowerCase() || 'unknown';
    return { pid, title, exe, appId };
  } catch {
    return null;
  }
}

type StrategyFn = () => Promise<ActiveAppWindow | null>;
let selected: StrategyFn | null = null;

function computePriorityList(): StrategyFn[] {
  const list: StrategyFn[] = [];
  // Order required by spec:
  // 1) X11 via xprop (needs DISPLAY)
  if (isX11() && which('xprop')) list.push(tryXProp);
  // 2) Sway/Wayland (needs WAYLAND_DISPLAY)
  if (isWayland() && which('swaymsg')) list.push(trySway);
  // 3) Hyprland/Wayland (needs WAYLAND_DISPLAY)
  if (isWayland() && which('hyprctl')) list.push(tryHyprland);
  return list;
}

export async function getActiveAppWindow(): Promise<ActiveAppWindow> {
  // If a strategy is already selected, try it first to avoid extra spawns per tick.
  if (selected) {
    try {
      const res = await selected();
      if (res && (res.pid || res.title || res.appId !== 'unknown')) {
        return res;
      }
    } catch {
      // fall through to re-detect
    }
    selected = null; // force re-detect on failure
  }

  const strategies = computePriorityList();
  for (const s of strategies) {
    try {
      const res = await s();
      if (res && (res.pid || res.title || res.appId !== 'unknown')) {
        selected = s; // cache winning strategy
        return res;
      }
    } catch {
      // continue
    }
  }

  // Ultimate fallback
  if (!warnedUnknownOnce) {
    try { logWarn('Linux: No supported compositor tools detected; returning minimal unknown active window info'); } catch {}
    warnedUnknownOnce = true;
  }
  return { pid: 0, title: '', exe: '', appId: 'unknown' };
}