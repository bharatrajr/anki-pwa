// Card state machine for answering cards, modelled on Anki's v3 scheduler
// (rslib/src/scheduler/states/*). Supports FSRS-6 and SM-2 per deck preset.
//
// Anki card fields used (same meaning and units as Anki):
//   type:  0 new, 1 learning, 2 review, 3 relearning
//   queue: -3 user-buried, -2 sibling-buried, -1 suspended, 0 new, 1 learning (due = epoch s),
//          2 review (due = day number), 3 interday learning (due = day number)
//   ivl: days (review); factor: ease ‰ (2500 = 250%); left: learning steps remaining
// Extra fields: stability, difficulty (FSRS memory state), lastReview (epoch ms).

import { nextMemory, intervalFor, normaliseParams, memoryFromSm2, retrievability } from './fsrs.js';
import { seededRandom, hash32 } from '../util/hash.js';

export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
export const REVLOG = { LEARN: 0, REVIEW: 1, RELEARN: 2, FILTERED: 3, MANUAL: 4, RESCHEDULE: 5 };

export const DEFAULT_PRESET = Object.freeze({
  id: 1,
  name: 'Default',
  scheduler: 'fsrs', // 'fsrs' | 'sm2'
  retention: 0.9,
  fsrsParams: null, // null = default FSRS-6 parameters
  learnSteps: [1, 10], // minutes
  relearnSteps: [10],
  gradIvl: 1,
  easyIvl: 4,
  maxIvl: 36500,
  newPerDay: 100,
  revPerDay: 500,
  buryNew: false,
  buryRev: false,
  buryInterday: false,
  leechThreshold: 8,
  leechAction: 'tag', // 'tag' | 'suspend'
  startingEase: 2.5,
  easyBonus: 1.3,
  hardMult: 1.2,
  ivlMod: 1.0,
  lapseMult: 0,
  minLapseIvl: 1,
  fuzz: true,
  newOrder: 'due', // 'due' | 'random'
});

export function withDefaults(preset) {
  return { ...DEFAULT_PRESET, ...(preset || {}) };
}

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

/** Anki/FSRS fuzz range for an interval. */
export function fuzzRange(ivl) {
  let delta = 1;
  for (const r of FUZZ_RANGES) delta += r.factor * Math.max(Math.min(ivl, r.end) - r.start, 0);
  return [Math.round(ivl - delta), Math.round(ivl + delta)];
}

/** Round, fuzz and clamp an interval to [minIvl, maxIvl]. */
export function constrainInterval(ivl, minIvl, maxIvl, rand, fuzz) {
  let result;
  if (!fuzz || ivl < 2.5 || !rand) result = Math.round(ivl);
  else {
    let [lo, hi] = fuzzRange(ivl);
    lo = Math.max(lo, 2, minIvl);
    hi = Math.max(Math.min(hi, maxIvl), lo);
    result = Math.floor(rand() * (hi - lo + 1)) + lo;
  }
  return Math.min(Math.max(result, minIvl, 1), Math.max(maxIvl, 1));
}

/**
 * Context: { now (ms), today (Anki day), dayOf(ms) → day number, nextDayStart (ms), preset }
 * Returns an array of 4 outcomes (index 0 = Again), each:
 *   { card: <full updated card>, seconds: <interval for the button label>, revlog: {...} }
 */
export function nextStates(card, ctx) {
  return [1, 2, 3, 4].map((g) => answerOutcome(card, g, ctx));
}

function hardDelaySecs(steps, idx) {
  const s = steps.map((m) => m * 60);
  if (idx === 0) {
    if (s.length > 1) return (s[0] + s[1]) / 2;
    return Math.min(s[0] * 1.5, s[0] + 86400);
  }
  return s[Math.min(idx, s.length - 1)];
}

function memoryFor(card, ctx, g) {
  const p = ctx.preset;
  const w = normaliseParams(p.fsrsParams);
  let mem = card.stability ? { stability: card.stability, difficulty: card.difficulty } : null;
  if (!mem && (card.type === 2 || card.type === 3) && card.ivl > 0) {
    mem = memoryFromSm2(w, card.ivl, card.factor, p.retention);
  }
  const elapsed = card.lastReview ? Math.max(0, ctx.today - ctx.dayOf(card.lastReview)) : elapsedFromDue(card, ctx);
  return nextMemory(w, mem, mem ? elapsed : 0, g);
}

// Without lastReview (e.g. imported card), estimate days since last review from due - ivl.
function elapsedFromDue(card, ctx) {
  if (card.type === 2 && card.queue === 2) return Math.max(0, ctx.today - (card.due - card.ivl));
  return 0;
}

function fsrsIvl(stability, ctx) {
  const w = normaliseParams(ctx.preset.fsrsParams);
  return intervalFor(w, stability, ctx.preset.retention) * 1; // ivlMod is not used with FSRS (Anki ignores it)
}

/** Compute all four review intervals so they are ordered hard ≤ good < easy, like Anki. */
function reviewIntervals(card, ctx, rand) {
  const p = ctx.preset;
  const maxIvl = p.maxIvl;
  const daysLate = Math.max(0, ctx.today - card.due);
  const fuzz = p.fuzz;
  if (p.scheduler === 'fsrs') {
    const mems = [2, 3, 4].map((g) => memoryFor(card, ctx, g));
    const raw = mems.map((m) => fsrsIvl(m.stability, ctx));
    let hard = constrainInterval(raw[0], 1, maxIvl, rand, fuzz);
    let good = constrainInterval(raw[1], 1, maxIvl, rand, fuzz);
    let easy = constrainInterval(raw[2], 1, maxIvl, rand, fuzz);
    hard = Math.min(hard, good);
    good = Math.min(Math.max(good, hard + 1), maxIvl);
    easy = Math.min(Math.max(easy, good + 1), maxIvl);
    return { ivls: [hard, good, easy], mems };
  }
  // SM-2 (Anki v3 rules)
  const ease = (card.factor || p.startingEase * 1000) / 1000;
  const cur = Math.max(card.ivl, 1);
  const minHard = p.hardMult > 1 ? cur + 1 : 1;
  const hard = constrainInterval(cur * p.hardMult * p.ivlMod, minHard, maxIvl, rand, fuzz);
  const good = constrainInterval((cur + daysLate / 2) * ease * p.ivlMod, Math.min(hard + 1, maxIvl), maxIvl, rand, fuzz);
  const easy = constrainInterval((cur + daysLate) * ease * p.easyBonus * p.ivlMod, Math.min(good + 1, maxIvl), maxIvl, rand, fuzz);
  return { ivls: [hard, good, easy], mems: null };
}

/** Graduation intervals from (re)learning: [good, easy] in days. */
function graduationIntervals(card, ctx, rand, relearning) {
  const p = ctx.preset;
  if (p.scheduler === 'fsrs') {
    const mg = memoryFor(card, ctx, 3), me = memoryFor(card, ctx, 4);
    const good = constrainInterval(fsrsIvl(mg.stability, ctx), 1, p.maxIvl, rand, p.fuzz);
    const easy = Math.min(Math.max(constrainInterval(fsrsIvl(me.stability, ctx), 1, p.maxIvl, rand, p.fuzz), good + 1), p.maxIvl);
    return [good, easy];
  }
  if (relearning) {
    const good = Math.max(card.ivl, 1);
    return [good, Math.min(good + 1, p.maxIvl)];
  }
  const good = constrainInterval(p.gradIvl, 1, p.maxIvl, rand, p.fuzz);
  const easy = constrainInterval(p.easyIvl, Math.min(good + 1, p.maxIvl), p.maxIvl, rand, p.fuzz);
  return [good, easy];
}

function scheduleLearning(next, delaySecs, ctx) {
  const dueMs = ctx.now + delaySecs * 1000;
  if (dueMs >= ctx.nextDayStart && delaySecs >= 86400) {
    // Interday learning step: due on a day number.
    const days = Math.max(1, Math.round(delaySecs / 86400));
    next.queue = 3;
    next.due = ctx.today + days;
    return days * 86400;
  }
  next.queue = 1;
  next.due = Math.floor(dueMs / 1000);
  return delaySecs;
}

function scheduleReview(next, ivl, ctx) {
  next.type = 2;
  next.queue = 2;
  next.ivl = ivl;
  next.due = ctx.today + ivl;
  next.left = 0;
  return ivl * 86400;
}

function answerOutcome(card, g, ctx) {
  const p = ctx.preset;
  const rand = seededRandom(hash32(card.id, card.reps));
  const next = { ...card };
  next.reps = card.reps + 1;
  next.lastReview = ctx.now;
  let seconds;
  let revType = card.type === 2 ? REVLOG.REVIEW : card.type === 3 ? REVLOG.RELEARN : REVLOG.LEARN;
  const lastIvl = card.type === 2 || card.type === 3 ? card.ivl : card.type === 1 ? -lastStepSecs(card, p) : 0;
  let leech = false;

  if (p.scheduler === 'fsrs') {
    const m = memoryFor(card, ctx, g);
    next.stability = m.stability;
    next.difficulty = m.difficulty;
  }
  if (card.type === 0 && p.scheduler === 'sm2') next.factor = Math.round(p.startingEase * 1000);
  if (card.type === 0 && p.scheduler === 'fsrs' && !next.factor) next.factor = Math.round(p.startingEase * 1000);

  if (card.type === 0 || card.type === 1) {
    const steps = p.learnSteps;
    const remaining = card.type === 0 ? steps.length : clampLeft(card.left, steps.length);
    const idx = steps.length - remaining;
    if (steps.length === 0 || (g === 3 && remaining <= 1) || g === 4) {
      const [good, easy] = graduationIntervals(card, ctx, rand, false);
      seconds = scheduleReview(next, g === 4 ? easy : good, ctx);
    } else {
      next.type = 1;
      let delay;
      if (g === 1) { next.left = steps.length; delay = steps[0] * 60; }
      else if (g === 2) { next.left = remaining; delay = hardDelaySecs(steps, idx); }
      else { next.left = remaining - 1; delay = steps[idx + 1] * 60; }
      seconds = scheduleLearning(next, delay, ctx);
    }
  } else if (card.type === 2) {
    if (g === 1) {
      next.lapses = card.lapses + 1;
      leech = isLeech(next.lapses, p.leechThreshold);
      let newIvl;
      if (p.scheduler === 'fsrs') {
        newIvl = constrainInterval(fsrsIvl(next.stability, ctx), 1, p.maxIvl, rand, p.fuzz);
      } else {
        next.factor = Math.max(1300, (card.factor || 2500) - 200);
        newIvl = Math.max(p.minLapseIvl, Math.round(card.ivl * p.lapseMult), 1);
      }
      next.ivl = newIvl;
      if (p.relearnSteps.length) {
        next.type = 3;
        next.left = p.relearnSteps.length;
        seconds = scheduleLearning(next, p.relearnSteps[0] * 60, ctx);
      } else {
        seconds = scheduleReview(next, newIvl, ctx);
      }
    } else {
      const { ivls } = reviewIntervals(card, ctx, rand);
      if (p.scheduler === 'sm2') {
        const f = card.factor || 2500;
        if (g === 2) next.factor = Math.max(1300, f - 150);
        if (g === 4) next.factor = f + 150;
      }
      seconds = scheduleReview(next, ivls[g - 2], ctx);
    }
  } else if (card.type === 3) {
    const steps = p.relearnSteps;
    const remaining = clampLeft(card.left, steps.length);
    const idx = steps.length - remaining;
    if (steps.length === 0 || (g === 3 && remaining <= 1) || g === 4) {
      const [good, easy] = graduationIntervals(card, ctx, rand, true);
      seconds = scheduleReview(next, g === 4 ? easy : good, ctx);
    } else {
      let delay;
      if (g === 1) { next.left = steps.length; delay = steps[0] * 60; }
      else if (g === 2) { next.left = remaining; delay = hardDelaySecs(steps, idx); }
      else { next.left = remaining - 1; delay = steps[idx + 1] * 60; }
      seconds = scheduleLearning(next, delay, ctx);
    }
  }

  const revlog = {
    cid: card.id,
    ease: g,
    ivl: next.queue === 2 ? next.ivl : -Math.round(seconds),
    lastIvl: lastIvl,
    factor: next.factor || 0,
    type: revType,
  };
  return { card: next, seconds, revlog, leech };
}

function clampLeft(left, n) {
  const r = (left || 0) % 1000; // tolerate Anki v2 encoding (today*1000 + remaining)
  return Math.min(Math.max(r, 1), Math.max(n, 1));
}

function lastStepSecs(card, p) {
  const steps = card.type === 3 ? p.relearnSteps : p.learnSteps;
  if (!steps.length) return 60;
  const idx = steps.length - clampLeft(card.left, steps.length);
  return steps[Math.max(0, Math.min(idx, steps.length - 1))] * 60;
}

/** Anki: leech when lapses reach the threshold, then every half-threshold after. */
export function isLeech(lapses, threshold) {
  if (!threshold) return false;
  if (lapses < threshold) return false;
  return (lapses - threshold) % Math.max(Math.floor(threshold / 2), 1) === 0;
}

/** Current retrievability for card info (FSRS cards only). */
export function currentRetrievability(card, ctx) {
  if (!card.stability || !card.lastReview) return null;
  const w = normaliseParams(ctx.preset.fsrsParams);
  return retrievability(w, Math.max(0, ctx.today - ctx.dayOf(card.lastReview)), card.stability);
}

/** A brand-new card record. */
export function newCard({ id, nid, did, ord, due, now }) {
  return {
    id, nid, did, ord, mod: now, type: 0, queue: 0, due, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0,
    odue: 0, odid: 0, flags: 0, stability: 0, difficulty: 0, lastReview: 0, data: '',
  };
}
