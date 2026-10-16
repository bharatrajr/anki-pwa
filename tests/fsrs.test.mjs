// FSRS memory model checked against the ts-fsrs reference implementation (dev dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, nextMemory, retrievability, intervalFor } from '../js/sched/fsrs.js';

let ref;
try {
  ref = await import('ts-fsrs');
} catch {
  ref = null;
}

test('default parameters match ts-fsrs FSRS-6 defaults', { skip: !ref && 'ts-fsrs not installed' }, () => {
  assert.deepEqual([...DEFAULT_PARAMS], [...ref.default_w]);
});

test('memory state transitions match ts-fsrs over random review histories', { skip: !ref && 'ts-fsrs not installed' }, () => {
  const algo = new ref.FSRSAlgorithm({ w: [...ref.default_w], enable_short_term: true });
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 200; run++) {
    let mine = null, theirs = null;
    for (let step = 0; step < 12; step++) {
      const g = 1 + Math.floor(rnd() * 4);
      const t = step === 0 ? 0 : Math.floor(rnd() * 3) === 0 ? 0 : Math.floor(rnd() * 120);
      mine = nextMemory(DEFAULT_PARAMS, mine, t, g);
      theirs = algo.next_state(theirs, t, g);
      assert.ok(Math.abs(mine.stability - theirs.stability) <= 1e-6 * Math.max(1, theirs.stability), `S run ${run} step ${step}: ${mine.stability} vs ${theirs.stability}`);
      assert.ok(Math.abs(mine.difficulty - theirs.difficulty) < 1e-6, `D run ${run} step ${step}`);
    }
  }
});

test('retrievability and interval agree with ts-fsrs', { skip: !ref && 'ts-fsrs not installed' }, () => {
  const algo = new ref.FSRSAlgorithm({ w: [...ref.default_w], request_retention: 0.9, maximum_interval: 36500 });
  for (const s of [0.5, 1, 3.7, 10, 55.2, 400]) {
    for (const t of [0, 1, 5, 30, 300]) {
      assert.ok(Math.abs(retrievability(DEFAULT_PARAMS, t, s) - algo.forgetting_curve(t, s)) < 1e-7);
    }
    assert.equal(Math.min(Math.max(1, Math.round(intervalFor(DEFAULT_PARAMS, s, 0.9))), 36500), algo.next_interval(s, 0));
  }
});

test('at desired retention 0.9 the interval equals stability', () => {
  assert.ok(Math.abs(intervalFor(DEFAULT_PARAMS, 20, 0.9) - 20) < 1e-9);
  assert.ok(intervalFor(DEFAULT_PARAMS, 20, 0.8) > 20);
  assert.ok(intervalFor(DEFAULT_PARAMS, 20, 0.97) < 20);
});
