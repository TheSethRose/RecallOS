// Settings window logic extracted from settings.html
(function(){
  const byId = (id) => document.getElementById(id);
  // Tab nav with hash support
  function activateTab(tab) {
    const id = 'tab-' + tab;
    const target = document.getElementById(id);
    if (!target) return;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const match = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (match) match.classList.add('active');
    document.querySelectorAll('.tab').forEach(sec => { sec.hidden = (sec.id !== id); });
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  }
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      activateTab(tab);
    });
  });
  // Initial tab from hash or default
  (function initTabFromHash() {
    const hash = (location.hash || '').replace('#','');
    const valid = ['general','capture','storage','calendar','security','analytics','export','apps'];
    if (valid.includes(hash)) activateTab(hash); else activateTab('general');
  })();
  byId('close-window').addEventListener('click', () => window.close());

  // Initialize settings values
  (async () => {
    const s = await window.recallos?.getSettings?.();
    // General
    try { byId('privacy').value = String(s?.privacy_indicator || 'on'); } catch {}
    try { const mode = String(s?.theme || 'system'); byId('theme').value = mode; } catch {}
    try { const li = await window.recallos?.getLoginItem?.(); byId('start-login').checked = !!li?.openAtLogin; } catch {}
  try { byId('bg-minimize').checked = String(s?.background_minimize || 'off') === 'on'; } catch {}
    // Capture
    try { byId('ocr-fps').value = String(s?.ocr_fps || '0.2'); } catch {}
    try { byId('stt-threads').value = String(s?.stt_threads || ''); } catch {}
    // Storage
    try { byId('data-dir').textContent = s?.data_dir || '(default)'; } catch {}
    try { byId('retention').value = String(s?.retention_days || '0'); } catch {}
    // Security
    try { const feats = await window.recallos?.getSqlFeatures?.(); if (!feats?.ok || !feats.sqlcipher) { byId('rekey-apply').setAttribute('disabled','true'); byId('rekey-hint').textContent = 'SQLCipher not linked in this build'; } } catch {}
    // Analytics
    try { byId('telemetry-usage').checked = String(s?.telemetry_usage||'off') === 'on'; } catch {}
    try { byId('telemetry-errors').checked = String(s?.telemetry_errors||'off') === 'on'; } catch {}
    // Calendar
    try { byId('calendar-overlays').checked = String(s?.calendar_overlays||'off') === 'on'; } catch {}
  })();

  // General handlers
  byId('theme').addEventListener('change', async (e) => {
    try { await window.recallos?.setSetting?.('theme', e.target.value); } catch {}
  });
  byId('start-login').addEventListener('change', async (e) => {
    try { const res = await window.recallos?.setLoginItem?.(!!e.target.checked); if (!res?.ok) alert('Unable to update start-on-login'); } catch {}
  });
  byId('bg-minimize').addEventListener('change', async (e) => {
    try { await window.recallos?.setSetting?.('background_minimize', e.target.checked ? 'on' : 'off'); } catch {}
  });
  byId('privacy').addEventListener('change', async (e) => {
    try { await window.recallos?.setSetting?.('privacy_indicator', e.target.value); } catch {}
  });

  // Capture handlers
  byId('ocr-apply').addEventListener('click', async () => {
    const lang = byId('ocr-lang').value; const fps = Math.max(0.05, Math.min(5, Number(byId('ocr-fps').value || '0.2')));
    try { await window.recallos?.setSetting?.('ocr_fps', String(fps)); } catch {}
    try { await window.recallos?.ensureOcrLanguage?.(lang); alert('OCR language ensured.'); } catch { alert('Failed to ensure OCR language.'); }
  });
  byId('stt-apply').addEventListener('click', async () => {
    const model = byId('stt-model').value; const threads = byId('stt-threads').value.trim();
    try { await window.recallos?.setSttModel?.(model); } catch {}
    try { if (threads) await window.recallos?.setSetting?.('stt_threads', String(Math.max(1, Math.min(16, Number(threads))))); } catch {}
    alert('STT settings applied.');
  });

  // Storage handlers
  byId('data-dir-choose').addEventListener('click', async () => {
    try { const res = await window.recallos?.chooseDirectory?.(); if (res?.ok && res.path) { byId('data-dir').textContent = res.path; await window.recallos?.setSetting?.('data_dir', res.path); } } catch {}
  });
  byId('retention-save').addEventListener('click', async () => {
    const v = Math.max(0, Math.min(3650, Math.floor(Number(byId('retention').value || '0'))));
    try { await window.recallos?.setSetting?.('retention_days', String(v)); alert('Retention days saved.'); } catch { alert('Failed to save.'); }
  });
  byId('retention-run').addEventListener('click', async () => {
    try { const res = await window.recallos?.runRetentionCleanup?.(); alert(res?.ok ? `Deleted ${res.deleted||0} old chunk(s).` : `Retention run failed: ${res?.error||'unknown'}`); } catch { alert('Retention run failed.'); }
  });

  // Security handlers
  byId('rekey-apply').addEventListener('click', async () => {
    const pass = byId('rekey-pass').value; if (!pass || pass.length < 4) { alert('Enter a passphrase (min 4 chars)'); return; }
    const res = await window.recallos?.setSqlPassphrase?.(pass);
    if (res?.ok) { alert('Database rekeyed. Quit and restart the app with RECALLOS_PASSPHRASE set.'); byId('rekey-pass').value = ''; }
    else { alert('Rekey failed: ' + (res?.error || 'unknown')); }
  });

  // Analytics handlers
  byId('telemetry-save').addEventListener('click', async () => {
    try {
      const on = (id) => { const el = byId(id); return el && el.checked ? 'on' : 'off'; };
      await window.recallos?.setSetting?.('telemetry_usage', on('telemetry-usage'));
      await window.recallos?.setSetting?.('telemetry_errors', on('telemetry-errors'));
      alert('Telemetry preferences saved.');
    } catch { alert('Failed to save telemetry settings.'); }
  });

  // Calendar handlers
  byId('calendar-save').addEventListener('click', async () => {
    try { const on = byId('calendar-overlays').checked ? 'on' : 'off'; await window.recallos?.setSetting?.('calendar_overlays', on); alert('Calendar preference saved.'); } catch { alert('Failed to save.'); }
  });
  document.getElementById('calendar-import-ics')?.addEventListener('click', async () => {
    try {
      const res = await window.recallos?.importIcs?.();
      if (!res) { alert('Import failed.'); return; }
      if (res.cancelled) { alert('Import cancelled.'); return; }
      const n = res.imported || 0;
      alert(n === 0 ? 'No files imported.' : `Imported ${n} file${n === 1 ? '' : 's'}.`);
    } catch {
      alert('Import failed.');
    }
  });

  // Export & Backup
  let backupDest = null;
  byId('backup-choose').addEventListener('click', async () => {
    const res = await window.recallos?.chooseDirectory?.();
    if (res?.ok && res.path) { backupDest = res.path; byId('backup-dest').textContent = res.path; }
  });
  byId('backup-run').addEventListener('click', async () => {
    if (!backupDest) { alert('Choose a destination folder first.'); return; }
    const includeManifest = !!byId('backup-manifest').checked;
    const res = await window.recallos?.runBackup?.(backupDest, { includeManifest });
    if (res?.ok) alert(`Backup created at ${res.path}. Files: ${res.files}`); else alert(`Backup failed: ${res?.error||'unknown'}`);
  });
  byId('export-run').addEventListener('click', async () => {
    try {
      const fromStr = byId('export-from').value; const toStr = byId('export-to').value;
      const toEpoch = (dstr) => dstr ? Math.floor(new Date(dstr + 'T00:00:00').getTime() / 1000) : undefined;
      const from = toEpoch(fromStr); const to = toEpoch(toStr) ? (toEpoch(toStr) + 24*3600 - 1) : undefined;
      if (!from || !to) { alert('Choose a valid date range'); return; }
      const dest = await window.recallos?.chooseDirectory?.(); if (!dest?.ok || !dest.path) return;
      const res = await window.recallos?.exportRange?.(dest.path, from, to, { includeMedia: !!byId('export-media').checked });
      if (res?.ok) alert(`Exported to ${res.path}`); else alert(`Export failed: ${res?.error||'unknown'}`);
    } catch { alert('Export failed.'); }
  });

  // Apps tab logic
  async function appsLoadDefaults() {
    const s = await window.recallos?.getSettings?.();
    let obj = {};
    try { obj = s?.app_opt_in_defaults ? JSON.parse(s.app_opt_in_defaults) : {}; } catch { obj = {}; }
    const cont = byId('apps-list');
    cont.innerHTML = '';
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) { cont.innerHTML = '<div class="muted">No per-app defaults set.</div>'; return; }
    keys.forEach(k => {
      const row = document.createElement('div');
      row.className = 'row';
      const key = document.createElement('code'); key.textContent = k; key.style.flex = '1';
      const val = document.createElement('span'); val.textContent = obj[k] === 'off' ? 'Do not capture' : 'Capture'; val.className = 'muted';
      const del = document.createElement('button'); del.textContent = 'Remove';
      del.addEventListener('click', async () => { delete obj[k]; await window.recallos?.setSetting?.('app_opt_in_defaults', JSON.stringify(obj)); await appsLoadDefaults(); });
      row.appendChild(key); row.appendChild(val); row.appendChild(del);
      cont.appendChild(row);
    });
  }
  byId('apps-add').addEventListener('click', async () => {
    const s = await window.recallos?.getSettings?.();
    let obj = {};
    try { obj = s?.app_opt_in_defaults ? JSON.parse(s.app_opt_in_defaults) : {}; } catch { obj = {}; }
    const key = byId('apps-key').value.trim();
    const def = byId('apps-default').value;
    if (!key) { alert('Enter a bundle ID or exe name'); return; }
    obj[key] = def === 'off' ? 'off' : 'on';
    await window.recallos?.setSetting?.('app_opt_in_defaults', JSON.stringify(obj));
    byId('apps-key').value = '';
    await appsLoadDefaults();
  });
  (async () => {
    try {
      const cur = await window.recallos?.getCurrentApp?.();
      const el = byId('apps-current');
      if (cur?.ok && cur.current && el) {
        el.textContent = `${cur.current.display_name} (${cur.current.bundle_or_exe}) — "${(cur.current.window_title||'').slice(0,64)}"`;
        byId('apps-rename-bundle').value = cur.current.bundle_or_exe;
      }
    } catch {}
  })();
  byId('apps-rename').addEventListener('click', async () => {
    const bundle = byId('apps-rename-bundle').value.trim();
    const name = byId('apps-rename-name').value.trim();
    if (!bundle) { alert('Enter a bundle/exe'); return; }
    const res = await window.recallos?.renameApp?.(bundle, name);
    if (!res?.ok) alert('Rename failed: ' + (res?.error || 'unknown'));
    byId('apps-rename-name').value = '';
  });
  appsLoadDefaults();
})();
