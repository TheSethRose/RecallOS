// Minimal ICS (RFC 5545) parser for VEVENTs without external deps
// Focus: DTSTART/DTEND (Z/LOCAL/DATE), SUMMARY, LOCATION, UID, DESCRIPTION

export type IcsEvent = {
  uid?: string | null;
  title?: string | null;
  location?: string | null;
  description?: string | null;
  dtStart: number; // epoch seconds
  dtEnd: number;   // epoch seconds
};

type Prop = {
  name: string;
  params: Record<string, string>;
  value: string;
};

function unfoldLines(input: string): string[] {
  // RFC5545 line folding: continuation lines begin with space or tab
  const raw = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (out.length === 0) { out.push(line.trimStart()); }
      else out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(";");
  const name = (parts.shift() || "").trim().toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toUpperCase();
    const v = p.slice(i + 1).trim();
    params[k] = v;
  }
  return { name, params, value };
}

function toInt(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  // YYYYMMDD
  if (!/^\d{8}$/.test(s)) return null;
  const y = toInt(s.slice(0, 4));
  const m = toInt(s.slice(4, 6));
  const d = toInt(s.slice(6, 8));
  return { y, m, d };
}

function parseYmdHms(s: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number; z: boolean } | null {
  // YYYYMMDDTHHMMSS(Z optional)
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  return {
    y: toInt(m[1]),
    m: toInt(m[2]),
    d: toInt(m[3]),
    hh: toInt(m[4]),
    mm: toInt(m[5]),
    ss: toInt(m[6]),
    z: !!m[7],
  };
}

function dateToEpochSecondsUTC(y: number, m: number, d: number, hh: number, mm: number, ss: number): number {
  // months are 0-based for Date.UTC
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
}

function dateToEpochSecondsLocal(y: number, m: number, d: number, hh: number, mm: number, ss: number): number {
  const dt = new Date(y, (m - 1), d, hh, mm, ss, 0);
  return Math.floor(dt.getTime() / 1000);
}

function parseIcsDateTime(value: string, params: Record<string, string>): { ts: number; isDateOnly: boolean } | null {
  const vdate = (params["VALUE"] || "").toUpperCase() === "DATE";
  if (vdate) {
    // Date-only (all-day): YYYYMMDD
    const d = parseYmd(value);
    if (!d) return null;
    // Interpret as local midnight
    const ts = dateToEpochSecondsLocal(d.y, d.m, d.d, 0, 0, 0);
    return { ts, isDateOnly: true };
  }

  const dt = parseYmdHms(value);
  if (dt) {
    if (dt.z) {
      const ts = dateToEpochSecondsUTC(dt.y, dt.m, dt.d, dt.hh, dt.mm, dt.ss);
      return { ts, isDateOnly: false };
    } else {
      // If TZID present, we cannot resolve without tz db; treat as local time
      const ts = dateToEpochSecondsLocal(dt.y, dt.m, dt.d, dt.hh, dt.mm, dt.ss);
      return { ts, isDateOnly: false };
    }
  }

  // Fallback: try YYYYMMDD as local midnight
  const d2 = parseYmd(value);
  if (d2) {
    const ts = dateToEpochSecondsLocal(d2.y, d2.m, d2.d, 0, 0, 0);
    return { ts, isDateOnly: true };
  }
  return null;
}

function sanitizeText(s: string | undefined | null): string | null {
  if (!s) return null;
  // Unescape RFC5545 escaped characters: \n, \\, \;, \,
  let out = s.replace(/\\n/gi, "\n").replace(/\\\\/g, "\\").replace(/\\;/g, ";").replace(/\\,/g, ",");
  out = out.replace(/[\u0000-\u001F\u007F]+/g, " ").normalize("NFC").trim();
  return out.length ? out : null;
}

export function parseICS(input: string): IcsEvent[] {
  const lines = unfoldLines(input);
  const events: IcsEvent[] = [];

  let inEvent = false;
  let props: Record<string, Prop> = {};
  let multi: Record<string, Prop[]> = {};

  const startEvent = () => {
    inEvent = true;
    props = {};
    multi = {};
  };

  const endEvent = () => {
    if (!inEvent) return;
    // Build event
    const get = (k: string) => props[k]?.value ?? null;
    const getMultiVals = (k: string) => (multi[k] || []).map(p => p.value);

    const uid = sanitizeText(get("UID"));
    const title = sanitizeText(get("SUMMARY"));
    const location = sanitizeText(get("LOCATION"));
    const description = sanitizeText(get("DESCRIPTION"));

    let startSec = 0;
    let endSec = 0;

    // DTSTART
    const dtstartProp = props["DTSTART"];
    if (dtstartProp) {
      const parsed = parseIcsDateTime(dtstartProp.value.trim(), dtstartProp.params);
      if (parsed) startSec = parsed.ts;
    }
    // DTEND
    const dtendProp = props["DTEND"];
    let dtendParsed: { ts: number; isDateOnly: boolean } | null = null;
    if (dtendProp) {
      dtendParsed = parseIcsDateTime(dtendProp.value.trim(), dtendProp.params);
    }

    // If no DTEND:
    // - for DATE-only DTSTART: treat as all-day (24h)
    // - otherwise: zero-length
    if (dtendParsed) {
      endSec = dtendParsed.ts;
      // In DATE-only DTEND, ics often uses exclusive end (next day). We'll keep as provided.
    } else {
      // Determine if DTSTART looked like date-only
      let isDateOnly = false;
      if (dtstartProp) {
        const parsed = parseIcsDateTime(dtstartProp.value.trim(), dtstartProp.params);
        isDateOnly = !!parsed?.isDateOnly;
      }
      endSec = startSec + (isDateOnly ? 86400 : 0);
    }

    // Defensive guards
    if (!Number.isFinite(startSec)) startSec = 0;
    if (!Number.isFinite(endSec)) endSec = startSec;

    // Only push when we have at least a time anchor
    if (startSec > 0) {
      events.push({
        uid,
        title,
        location,
        description,
        dtStart: Math.floor(startSec),
        dtEnd: Math.floor(endSec),
      });
    }

    inEvent = false;
    props = {};
    multi = {};
  };

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      startEvent();
      continue;
    }
    if (line === "END:VEVENT") {
      endEvent();
      continue;
    }
    if (!inEvent) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    const name = prop.name.toUpperCase();
    if (!props[name]) props[name] = prop;
    else {
      if (!multi[name]) multi[name] = [];
      multi[name].push(prop);
    }
  }
  // Graceful close if file missed END:VEVENT
  if (inEvent) endEvent();

  return events;
}