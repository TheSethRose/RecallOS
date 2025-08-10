import { contextBridge, ipcRenderer, desktopCapturer } from 'electron';

contextBridge.exposeInMainWorld('recallos', {
  ping: () => 'pong',
  // IPC methods — validated in main
  search: async (q: string, limit = 20, offset = 0, opts?: { speaker?: 'me'|'others'|'unknown'; type?: 'ocr'|'transcript'; from?: number; to?: number; app?: string; window?: string }) =>
    ipcRenderer.invoke('recallos:search', { q, limit, offset, ...(opts||{}) }),
  searchSnippets: async (q: string, limit = 20, offset = 0, windowChars = 80, opts?: { speaker?: 'me'|'others'|'unknown'; type?: 'ocr'|'transcript'; from?: number; to?: number; app?: string; window?: string }) =>
    ipcRenderer.invoke('recallos:searchSnippets', { q, limit, offset, windowChars, ...(opts||{}) }),
  getSettings: async () => ipcRenderer.invoke('recallos:getSettings'),
  setSetting: async (key: string, value: string) => ipcRenderer.invoke('recallos:setSetting', { key, value }),
  enqueueJob: async (type: string, payload: any, delaySec?: number) => ipcRenderer.invoke('recallos:enqueueJob', { type, payload, delaySec }),
  queueStats: async () => ipcRenderer.invoke('recallos:queueStats'),
  micPermissionStatus: async () => ipcRenderer.invoke('recallos:perm:mic:status'),
  micPermissionRequest: async () => ipcRenderer.invoke('recallos:perm:mic:request'),
  openScreenRecordingSettings: async () => ipcRenderer.invoke('recallos:perm:screen:openSettings'),
  chooseDirectory: async () => ipcRenderer.invoke('recallos:dialog:chooseDir'),
  getSqlFeatures: async () => ipcRenderer.invoke('recallos:sql:features'),
  listCaptureSources: async (types: Array<'screen' | 'window'> = ['screen', 'window']) => {
    const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 200 } });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      kind: s.id?.startsWith('screen:') ? 'screen' : (s.id?.startsWith('window:') ? 'window' : 'unknown'),
      displayId: (s as any).display_id || (s as any).displayId || null,
      thumbnail: s.thumbnail?.toDataURL?.() || null
    }));
  },
  detectSystemAudio: async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const labels = (devs || []).map(d => (d.label || '').toLowerCase());
      const mac = process.platform === 'darwin';
      const hasLoop = labels.some(l => l.includes('blackhole') || l.includes('loopback') || l.includes('soundflower') || l.includes('monitor') || l.includes('stereo mix'));
      return { platform: process.platform, detected: hasLoop, hint: mac ? 'Install BlackHole (2ch) for system audio capture' : undefined };
    } catch {
      return { platform: process.platform, detected: false };
    }
  },
  listAudioDevices: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label }));
    } catch (e) {
      return [];
    }
  },
  saveChunk: async (buffer: ArrayBuffer, meta: { startedAt?: number; durationMs?: number; type?: string; width?: number; height?: number; sample_rate?: number; channel_layout?: string; codec?: string; ext?: string; audio_role?: string }) =>
    ipcRenderer.invoke('recallos:saveChunk', { buffer, ...meta }),
  setRecordingIndicator: async (active: boolean) => ipcRenderer.invoke('recallos:recording:set', { active }),
  getMoment: async (payload: { chunk_id: number; ts_ms: number }) => ipcRenderer.invoke('recallos:getMoment', payload),
  // Saved searches
  getSavedSearches: async () => ipcRenderer.invoke('recallos:saved:get'),
  saveSearch: async (name: string, query: string) => ipcRenderer.invoke('recallos:saved:put', { name, query }),
  deleteSavedSearch: async (name: string) => ipcRenderer.invoke('recallos:saved:del', { name }),
  // OCR settings
  ensureOcrLanguage: async (lang: string) => ipcRenderer.invoke('recallos:ocr:ensureLang', { lang }),
  // STT settings
  setSttModel: async (name: string) => ipcRenderer.invoke('recallos:stt:setModel', { name }),
  // Apps
  listApps: async () => ipcRenderer.invoke('recallos:apps:list'),
  renameApp: async (bundle: string, display_name: string) => ipcRenderer.invoke('recallos:apps:rename', { bundle, display_name }),
  getCurrentApp: async () => ipcRenderer.invoke('recallos:app:current'),
});
