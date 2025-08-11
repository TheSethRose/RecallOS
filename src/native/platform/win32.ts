// T-078: Windows active app/window via Win32 FFI with PowerShell fallback
import { getFFI } from '../index';
import { logWarn } from '../../util/log';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { ActiveAppWindow } from '../index';

const execFileAsync = promisify(execFile);

let warnedFallback = false;

function sanitize(s: string): string {
  return String(s || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 512);
}

function fromWide(buf: Buffer): string {
  try {
    const s = buf.toString('utf16le');
    return sanitize(s.replace(/\u0000+$/g, ''));
  } catch {
    return '';
  }
}

export async function getActiveAppWindow(): Promise<ActiveAppWindow> {
  const handle = getFFI();
  if (handle.available) {
    try {
      const ffi = (handle as any).ffi;
      const ref = (handle as any).ref;

      const voidPtr = ref.refType(ref.types.void);
      const DWORD = ref.types.uint32;
      const LPDWORD = ref.refType(DWORD);
      const BOOL = ref.types.bool;
      const INT = ref.types.int;

      const user32 = ffi.Library('user32', {
        'GetForegroundWindow': [voidPtr, []],
        'GetWindowTextLengthW': [INT, [voidPtr]],
        'GetWindowTextW': [INT, [voidPtr, ref.refType(ref.types.uint16), INT]],
        'GetWindowThreadProcessId': [DWORD, [voidPtr, LPDWORD]],
        'IsWindowVisible': [BOOL, [voidPtr]],
      });
      const kernel32 = ffi.Library('kernel32', {
        'OpenProcess': [voidPtr, [DWORD, BOOL, DWORD]],
        'CloseHandle': [BOOL, [voidPtr]],
        'QueryFullProcessImageNameW': [BOOL, [voidPtr, DWORD, ref.refType(ref.types.uint16), LPDWORD]],
      });
      const psapi = ffi.Library('psapi', {
        'GetModuleFileNameExW': [DWORD, [voidPtr, voidPtr, ref.refType(ref.types.uint16), DWORD]],
      });

      const hwnd = user32.GetForegroundWindow();
      if (!hwnd) throw new Error('no-foreground');

      // Title
      let title = '';
      try {
        const len = Math.max(0, Number(user32.GetWindowTextLengthW(hwnd)) || 0);
        const buf = Buffer.alloc((len + 2) * 2);
        user32.GetWindowTextW(hwnd, buf, len + 1);
        title = fromWide(buf);
      } catch {}

      // PID
      const pidBuf = ref.alloc(DWORD);
      user32.GetWindowThreadProcessId(hwnd, pidBuf);
      const pid = Number(pidBuf.deref());

      // Process handle
      const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      const PROCESS_QUERY_INFORMATION = 0x0400;
      const PROCESS_VM_READ = 0x0010;

      let hProc: Buffer | null = null;
      try {
        hProc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (!hProc) {
          hProc = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        }
      } catch {}
      let exe = '';
      if (hProc) {
        try {
          // First try QueryFullProcessImageNameW
          let cap = 1024;
          let ok = false;
          try {
            const nameBuf = Buffer.alloc(cap * 2);
            const sizeBuf = ref.alloc(DWORD, cap);
            ok = !!kernel32.QueryFullProcessImageNameW(hProc, 0, nameBuf, sizeBuf);
            if (ok) {
              exe = fromWide(nameBuf);
            }
          } catch { ok = false; }
          if (!ok) {
            // Fallback to psapi
            try {
              const nameBuf = Buffer.alloc(1024 * 2);
              const written = Number(psapi.GetModuleFileNameExW(hProc, ref.NULL, nameBuf, 1024)) || 0;
              if (written > 0) {
                exe = fromWide(nameBuf);
              }
            } catch {}
          }
        } finally {
          try { kernel32.CloseHandle(hProc); } catch {}
        }
      }

      const exeBase = exe ? basename(exe) : '';
      const appId = (exeBase || '').toLowerCase() || `pid:${pid}`;
      return { pid, title, exe: exe || exeBase || '', appId };
    } catch (e) {
      // fall through to PowerShell
      if (!warnedFallback) { try { logWarn(`Win32 FFI active window failed: falling back to PowerShell (${e instanceof Error ? e.message : String(e)})`); } catch {} warnedFallback = true; }
    }
  } else {
    if (!warnedFallback) { try { logWarn(`FFI not available (${handle.reason || 'unknown'}); using PowerShell fallback for active window`); } catch {} warnedFallback = true; }
  }

  // PowerShell fallback (<=500ms)
  try {
    const script = `
$signature = @"
using System;
using System.Runtime.InteropServices;
public static class FWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
"@;
Add-Type -TypeDefinition $signature -PassThru | Out-Null;
$h = [FWin32]::GetForegroundWindow();
$pid = 0; [FWin32]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null;
$p = Get-Process -Id $pid -ErrorAction SilentlyContinue;
if ($p) {
  $exe = $null
  try { $exe = $p.MainModule.FileName } catch { $exe = $p.Path }
  $title = $p.MainWindowTitle
  "$pid\`t$exe\`t$title"
}
`.trim();
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 500, windowsHide: true, maxBuffer: 64 * 1024 });
    const out = String(stdout || '').trim();
    if (out) {
      const [pidStr = '', exeRaw = '', titleRaw = ''] = out.split('\t');
      const pid = Number(pidStr) || 0;
      const exe = sanitize(exeRaw);
      const title = sanitize(titleRaw);
      const appId = (exe ? basename(exe) : '').toLowerCase() || (pid ? `pid:${pid}` : 'unknown');
      return { pid, exe, title, appId };
    }
  } catch {}
  // Ultimate fallback
  return { pid: 0, exe: '', title: '', appId: 'unknown' };
}