export {};

declare global {
  interface Window {
    recallos?: {
      ping: () => string;
  search: (q: string, limit?: number, offset?: number, opts?: { speaker?: 'me'|'others'|'unknown'; type?: 'ocr'|'transcript'; from?: number; to?: number; app?: string; window?: string }) => Promise<Array<{ rowid: number; content: string; type: string; chunk_id: number; ts_ms: number }>>;
  searchSnippets: (q: string, limit?: number, offset?: number, windowChars?: number, opts?: { windowSecs?: number; speaker?: 'me'|'others'|'unknown'; type?: 'ocr'|'transcript'; from?: number; to?: number; app?: string; window?: string }) => Promise<Array<{ snippet: string; type: string; chunk_id: number; ts_ms: number; app_bundle?: string; app_name?: string; window_title?: string }>>;
  getSettings: () => Promise<Record<string, string>>;
  setSetting: (key: string, value: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  enqueueJob: (type: string, payload: any, delaySec?: number) => Promise<{ ok: true; id: number | null } | { ok: false; error: string }>;
  queueStats: () => Promise<Record<string, number>>;
  micPermissionStatus: () => Promise<{ platform?: string; status?: string; error?: string }>;
  micPermissionRequest: () => Promise<{ platform?: string; granted?: boolean; error?: string }>;
  openScreenRecordingSettings: () => Promise<{ ok: boolean; error?: string }>;
  listCaptureSources: (types?: Array<'screen' | 'window'>) => Promise<Array<{ id: string; name: string; kind: 'screen' | 'window' | 'unknown'; displayId: string | null; thumbnail: string | null }>>;
  detectSystemAudio: () => Promise<{ platform: string; detected: boolean; hint?: string }>;
  saveChunk: (buffer: ArrayBuffer, meta: { startedAt?: number; durationMs?: number; type?: string; width?: number; height?: number; sample_rate?: number; channel_layout?: string; codec?: string; ext?: string; audio_role?: string }) => Promise<{ ok: boolean; id?: number | null; path?: string; error?: string }>;
  listAudioDevices: () => Promise<Array<{ deviceId: string; label: string }>>;
  setRecordingIndicator: (active: boolean) => Promise<{ ok: boolean; error?: string }>;
  getMoment: (payload: { chunk_id: number; ts_ms: number }) => Promise<{ ok: true; path: string; absMs: number } | { ok: false; error: string }>;
  getSavedSearches: () => Promise<{ ok: boolean; searches?: Record<string, string>; error?: string }>;
  saveSearch: (name: string, query: string) => Promise<{ ok: boolean; error?: string }>;
  deleteSavedSearch: (name: string) => Promise<{ ok: boolean; error?: string }>;
  ensureOcrLanguage: (lang: string) => Promise<{ ok: boolean; res?: any; error?: string }>;
  setSttModel: (name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  // Apps
  listApps: () => Promise<{ ok: boolean; apps?: Array<{ id: number; bundle_or_exe: string; display_name: string }>; error?: string }>;
  renameApp: (bundle: string, display_name: string) => Promise<{ ok: boolean; error?: string }>;
  getCurrentApp: () => Promise<{ ok: boolean; current?: { bundle_or_exe: string; display_name: string; window_title: string } | null; error?: string }>;
    };
  }
}
