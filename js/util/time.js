// Day numbering compatible with Anki's v3 scheduler (rslib/src/scheduler/timing.rs):
// "today" = number of local calendar days (each starting at the rollover hour)
// between the collection creation time (col.crt, epoch seconds) and now.

const DAY_MS = 86400000;

/** Local calendar day index for a timestamp, where days start at `rolloverHour`. */
export function localDayIndex(ms, rolloverHour = 4) {
  const d = new Date(ms - rolloverHour * 3600000);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Days elapsed since collection creation = Anki's `today` value. */
export function daysElapsed(nowMs, colCrtSec, rolloverHour = 4) {
  return localDayIndex(nowMs, rolloverHour) - localDayIndex(colCrtSec * 1000, rolloverHour);
}

/** Epoch ms when the next day starts (next rollover). */
export function nextDayStartMs(nowMs, rolloverHour = 4) {
  const d = new Date(nowMs - rolloverHour * 3600000);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, rolloverHour, 0, 0, 0);
  return next.getTime();
}

/** A col.crt value for a brand-new collection: today's rollover moment, epoch seconds. */
export function newCollectionCrt(nowMs = Date.now(), rolloverHour = 4) {
  const d = new Date(nowMs - rolloverHour * 3600000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), rolloverHour).getTime() / 1000);
}

/** Calendar date (local) for an Anki day number. */
export function dayToDate(day, colCrtSec) {
  const base = new Date(colCrtSec * 1000);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, 12);
}

/** Human interval label like Anki: 45s, 10m, 3h, 4d, 2.1mo, 1.3y. */
export function fmtInterval(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${roundTrim(s / 3600)}h`;
  const days = s / 86400;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${roundTrim(days / 30)}mo`;
  return `${roundTrim(days / 365)}y`;
}
function roundTrim(x) {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
