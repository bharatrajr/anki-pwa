// Statistics computed from cards and the review log: today, review heatmap, future due
// forecast, true retention (Anki's definition), card counts and recent review counts.

import { REVLOG } from '../sched/scheduler.js';
import { cardRetrievability } from '../search/search.js';

const MATURE = 21;

/** did = null for the whole collection. */
export async function computeStats(col, did = null, timing = col.timing()) {
  const deckIds = did ? new Set(col.deckSubtreeIds(did)) : null;
  const inScope = (c) => !deckIds || deckIds.has(c.did) || (c.odid && deckIds.has(c.odid));
  const cards = (await col.allCards()).filter(inScope);
  const cids = new Set(cards.map((c) => c.id));
  const revlog = (await col.allRevlog()).filter((r) => cids.has(r.cid)).sort((a, b) => a.id - b.id);
  const { today } = timing;
  const dayOf = (ms) => timing.dayOf(ms);

  // ---- today ----
  const t = { count: 0, timeMs: 0, again: 0, learn: 0, review: 0, relearn: 0, filtered: 0, newCards: 0, reviewPass: 0, reviewTotal: 0 };
  const firstSeen = new Map();
  for (const r of revlog) if (r.type !== REVLOG.MANUAL && r.type !== REVLOG.RESCHEDULE && !firstSeen.has(r.cid)) firstSeen.set(r.cid, r.id);
  for (const r of revlog) {
    if (r.type === REVLOG.MANUAL || r.type === REVLOG.RESCHEDULE || dayOf(r.id) !== today) continue;
    t.count++;
    t.timeMs += r.time || 0;
    if (r.ease === 1) t.again++;
    if (r.type === REVLOG.LEARN) t.learn++;
    else if (r.type === REVLOG.REVIEW) { t.review++; t.reviewTotal++; if (r.ease > 1) t.reviewPass++; }
    else if (r.type === REVLOG.RELEARN) t.relearn++;
    else if (r.type === REVLOG.FILTERED) t.filtered++;
    if (firstSeen.get(r.cid) === r.id) t.newCards++;
  }

  // ---- heatmap: reviews per day for the last year ----
  const heat = new Map();
  for (const r of revlog) {
    if (r.type === REVLOG.MANUAL || r.type === REVLOG.RESCHEDULE) continue;
    const d = dayOf(r.id);
    if (d > today - 371) heat.set(d, (heat.get(d) || 0) + 1);
  }
  let streak = 0;
  for (let d = heat.has(today) ? today : today - 1; heat.has(d); d--) streak++;
  const studiedDays = [...heat.keys()].filter((d) => d > today - 365).length;

  // ---- reviews per day, last 30 days, by kind ----
  const recent = Array.from({ length: 30 }, (_, i) => ({ day: today - 29 + i, learn: 0, young: 0, mature: 0, relearn: 0, filtered: 0 }));
  for (const r of revlog) {
    const i = dayOf(r.id) - (today - 29);
    if (i < 0 || i >= 30) continue;
    const b = recent[i];
    if (r.type === REVLOG.LEARN) b.learn++;
    else if (r.type === REVLOG.RELEARN) b.relearn++;
    else if (r.type === REVLOG.FILTERED) b.filtered++;
    else if (r.type === REVLOG.REVIEW) { if (r.lastIvl >= MATURE) b.mature++; else b.young++; }
  }

  // ---- forecast: cards due over the next 30 days ----
  const forecast = Array.from({ length: 31 }, (_, i) => ({ day: today + i, young: 0, mature: 0, learn: 0 }));
  const nowSec = timing.now / 1000;
  let overdue = 0;
  for (const c of cards) {
    if (c.queue === 2 || c.queue === 3) {
      if (c.due < -1000) continue; // filtered deck sort key
      const i = Math.max(0, c.due - today);
      if (c.due < today) overdue++;
      if (i > 30) continue;
      if (c.queue === 3) forecast[i].learn++;
      else if (c.ivl >= MATURE) forecast[i].mature++;
      else forecast[i].young++;
    } else if (c.queue === 1) {
      const i = c.due <= nowSec ? 0 : Math.max(0, dayOf(c.due * 1000) - today);
      if (i <= 30) forecast[i].learn++;
    }
  }

  // ---- true retention: share of review-type answers that weren't Again ----
  const periods = [['Today', 1], ['Yesterday', -1], ['Last week', 7], ['Last month', 30], ['Last year', 365], ['All time', Infinity]];
  const retention = periods.map(([label, days]) => {
    const row = { label, young: { pass: 0, total: 0 }, mature: { pass: 0, total: 0 } };
    for (const r of revlog) {
      if (r.type !== REVLOG.REVIEW) continue;
      const d = dayOf(r.id);
      const ok = days === -1 ? d === today - 1 : days === Infinity ? true : d > today - days;
      if (!ok) continue;
      const b = r.lastIvl >= MATURE ? row.mature : row.young;
      b.total++;
      if (r.ease > 1) b.pass++;
    }
    return row;
  });

  // ---- card counts ----
  const counts = { new: 0, learning: 0, relearning: 0, young: 0, mature: 0, suspended: 0, buried: 0, total: cards.length };
  let rSum = 0, rN = 0;
  for (const c of cards) {
    if (c.queue === -1) counts.suspended++;
    else if (c.queue === -2 || c.queue === -3) counts.buried++;
    else if (c.type === 0) counts.new++;
    else if (c.type === 1) counts.learning++;
    else if (c.type === 3) counts.relearning++;
    else if (c.ivl >= MATURE) counts.mature++;
    else counts.young++;
    if (c.queue >= 0 && c.type === 2) {
      const r = cardRetrievability(c, timing, col);
      if (r !== null) { rSum += r; rN++; }
    }
  }

  return {
    today: t, heat, streak, studiedDays, recent, forecast, overdue, retention, counts,
    avgRetrievability: rN ? rSum / rN : null, totalReviews: revlog.length, timing,
  };
}
