// Scheduler state machine (FSRS and SM-2), fuzz, leeches, day numbering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStates, newCard, withDefaults, fuzzRange, constrainInterval, isLeech, REVLOG } from '../js/sched/scheduler.js';
import { daysElapsed, localDayIndex, newCollectionCrt, fmtInterval, nextDayStartMs } from '../js/util/time.js';
import { seededRandom } from '../js/util/hash.js';

process.env.TZ = 'Asia/Kolkata';

const NOW = new Date('2026-10-16T10:00:00+05:30').getTime();
const CRT = newCollectionCrt(new Date('2026-01-01T12:00:00+05:30').getTime(), 4);
function ctx(preset = {}, now = NOW) {
  return {
    now, today: daysElapsed(now, CRT, 4), nextDayStart: nextDayStartMs(now, 4),
    dayOf: (ms) => localDayIndex(ms, 4) - localDayIndex(CRT * 1000, 4), preset: withDefaults(preset),
  };
}
const fresh = () => newCard({ id: 1700000000000, nid: 1, did: 1, ord: 0, due: 1, now: NOW });

test('day numbering: rollover hour decides the day', () => {
  const crt = newCollectionCrt(new Date('2026-10-01T09:00:00+05:30').getTime(), 4);
  assert.equal(daysElapsed(new Date('2026-10-01T23:00:00+05:30').getTime(), crt, 4), 0);
  assert.equal(daysElapsed(new Date('2026-10-02T03:59:00+05:30').getTime(), crt, 4), 0, 'before 4am still yesterday');
  assert.equal(daysElapsed(new Date('2026-10-02T04:00:00+05:30').getTime(), crt, 4), 1);
  assert.equal(daysElapsed(new Date('2026-10-11T12:00:00+05:30').getTime(), crt, 4), 10);
});

test('new card, FSRS: learning steps 1m 10m then graduate', () => {
  const c = ctx();
  const [again, hard, good, easy] = nextStates(fresh(), c);
  assert.equal(again.seconds, 60);
  assert.equal(again.card.queue, 1);
  assert.equal(again.card.type, 1);
  assert.equal(hard.seconds, 330, 'Hard on first step = average of first two steps (5.5m)');
  assert.equal(good.seconds, 600);
  assert.equal(good.card.left, 1);
  assert.equal(easy.card.type, 2);
  assert.equal(easy.card.queue, 2);
  assert.ok(easy.card.ivl >= 1);
  assert.equal(easy.card.due, c.today + easy.card.ivl);
  assert.ok(easy.card.stability > 0 && easy.card.difficulty >= 1);
  assert.equal(again.revlog.type, REVLOG.LEARN);
  assert.equal(again.revlog.ivl, -60, 'learning intervals are negative seconds in the revlog');

  // Good on the last step graduates.
  const [, , grad] = nextStates(good.card, ctx({}, NOW + 600000));
  assert.equal(grad.card.type, 2);
  assert.equal(grad.card.left, 0);
});

test('review card, FSRS: Again → relearning; intervals ordered', () => {
  const c = ctx();
  const card = { ...fresh(), type: 2, queue: 2, ivl: 10, due: c.today, factor: 2500, reps: 5, stability: 10, difficulty: 5, lastReview: NOW - 10 * 86400000 };
  const [again, hard, good, easy] = nextStates(card, c);
  assert.equal(again.card.type, 3);
  assert.equal(again.card.queue, 1);
  assert.equal(again.card.lapses, 1);
  assert.equal(again.revlog.type, REVLOG.REVIEW);
  assert.ok(again.card.stability < card.stability);
  assert.ok(hard.card.ivl <= good.card.ivl && good.card.ivl < easy.card.ivl, `${hard.card.ivl} ${good.card.ivl} ${easy.card.ivl}`);
  // At 90% retention, interval ≈ stability (before fuzz).
  const fuzzless = nextStates(card, ctx({ fuzz: false }))[2];
  assert.equal(fuzzless.card.ivl, Math.round(fuzzless.card.stability));
});

test('desired retention changes intervals', () => {
  const card = { ...fresh(), type: 2, queue: 2, ivl: 20, due: ctx().today, stability: 20, difficulty: 5, lastReview: NOW - 20 * 86400000 };
  const lo = nextStates(card, ctx({ retention: 0.8, fuzz: false }))[2].card.ivl;
  const hi = nextStates(card, ctx({ retention: 0.97, fuzz: false }))[2].card.ivl;
  assert.ok(lo > hi * 3, `${lo} vs ${hi}`);
});

test('SM-2: graduating/easy intervals, ease changes, lapse', () => {
  const p = { scheduler: 'sm2', fuzz: false };
  const [, , good, easy] = nextStates(fresh(), ctx(p));
  assert.equal(good.card.type, 1);
  assert.equal(easy.card.ivl, 4);
  assert.equal(easy.card.factor, 2500);
  const c = ctx(p);
  const rev = { ...fresh(), type: 2, queue: 2, ivl: 10, due: c.today, factor: 2500, reps: 3 };
  const [again, hard, g, e] = nextStates(rev, c);
  assert.equal(hard.card.ivl, 12);
  assert.equal(hard.card.factor, 2350);
  assert.equal(g.card.ivl, 25);
  assert.equal(g.card.factor, 2500);
  assert.equal(e.card.ivl, Math.round(10 * 2.5 * 1.3));
  assert.equal(e.card.factor, 2650);
  assert.equal(again.card.factor, 2300);
  assert.equal(again.card.ivl, 1);
  // Relearning graduates back with the lapse interval.
  const [, , back] = nextStates(again.card, ctx(p, NOW + 600000));
  assert.equal(back.card.type, 2);
  assert.equal(back.card.ivl, 1);
});

test('SM-2: overdue reviews get credit for the delay', () => {
  const c = ctx({ scheduler: 'sm2', fuzz: false });
  const rev = { ...fresh(), type: 2, queue: 2, ivl: 10, due: c.today - 4, factor: 2500, reps: 3 };
  assert.equal(nextStates(rev, c)[2].card.ivl, Math.round((10 + 2) * 2.5));
});

test('interday learning steps use day numbers (queue 3)', () => {
  const c = ctx({ learnSteps: [10, 1440] });
  const [, , good] = nextStates(fresh(), c); // Good moves to the second step (1 day)
  assert.equal(good.card.queue, 3);
  assert.equal(good.card.due, c.today + 1);
  assert.equal(good.seconds, 86400);
});

test('fuzz stays inside Anki ranges and is deterministic per card', () => {
  assert.deepEqual(fuzzRange(10), [8, 12]);
  assert.deepEqual(fuzzRange(100), [93, 107]); // 1 + 0.15·4.5 + 0.1·13 + 0.05·80 ≈ 6.98
  for (let s = 1; s < 50; s++) {
    const v = constrainInterval(30, 1, 36500, seededRandom(s), true);
    assert.ok(v >= 27 && v <= 33, String(v));
  }
  assert.equal(constrainInterval(2, 1, 36500, seededRandom(1), true), 2, 'no fuzz under 2.5 days');
  assert.equal(constrainInterval(500, 1, 100, seededRandom(1), true), 100, 'max interval caps');
  const card = { ...fresh(), type: 2, queue: 2, ivl: 30, due: ctx().today, stability: 30, difficulty: 5, lastReview: NOW - 30 * 86400000 };
  assert.deepEqual(nextStates(card, ctx()).map((o) => o.card.ivl), nextStates(card, ctx()).map((o) => o.card.ivl));
});

test('leech threshold: at threshold then every half threshold', () => {
  assert.equal(isLeech(7, 8), false);
  assert.equal(isLeech(8, 8), true);
  assert.equal(isLeech(10, 8), false);
  assert.equal(isLeech(12, 8), true);
  const card = { ...fresh(), type: 2, queue: 2, ivl: 3, due: ctx().today, lapses: 7, stability: 3, difficulty: 8, lastReview: NOW - 3 * 86400000 };
  assert.equal(nextStates(card, ctx())[0].leech, true);
});

test('interval labels', () => {
  assert.equal(fmtInterval(60), '1m');
  assert.equal(fmtInterval(330), '6m');
  assert.equal(fmtInterval(86400 * 3), '3d');
  assert.equal(fmtInterval(86400 * 45), '1.5mo');
  assert.equal(fmtInterval(86400 * 400), '1.1y');
});
