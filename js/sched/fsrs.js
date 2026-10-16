// FSRS-6 memory model (21 parameters), as used by current Anki (fsrs-rs) and ts-fsrs.
// Formulas: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
// Verified against the ts-fsrs reference implementation in tests/fsrs.test.mjs.

export const DEFAULT_PARAMS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);

export const S_MIN = 0.001;
export const S_MAX = 36500;

const round8 = (x) => Math.round(x * 1e8) / 1e8;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** Upgrade older parameter sets (FSRS-4.5: 17, FSRS-5: 19) to 21 values. */
export function normaliseParams(w) {
  if (!Array.isArray(w) || w.length === 0) return [...DEFAULT_PARAMS];
  const p = [...w];
  if (p.length === 17) p.push(0, 0); // FSRS-4.5 has no short-term terms
  if (p.length === 19) p.push(0, 0.5); // FSRS-5: w19 = 0, decay 0.5
  if (p.length !== 21) return [...DEFAULT_PARAMS];
  return p;
}

export function decayFactor(w) {
  const decay = -w[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return { decay, factor };
}

/** Probability of recall after `t` days for stability `s`. */
export function retrievability(w, t, s) {
  const { decay, factor } = decayFactor(w);
  return round8(Math.pow(1 + (factor * t) / s, decay));
}

/** Interval (days, unrounded) at which R falls to `retention`. */
export function intervalFor(w, s, retention) {
  const { decay, factor } = decayFactor(w);
  return (s / factor) * (Math.pow(retention, 1 / decay) - 1);
}

export function initStability(w, g) {
  return Math.max(w[g - 1], 0.1);
}

export function initDifficulty(w, g) {
  return round8(w[4] - Math.exp((g - 1) * w[5]) + 1);
}

function nextDifficulty(w, d, g) {
  const delta = -w[6] * (g - 3);
  const next = d + round8((delta * (10 - d)) / 9);
  return clamp(round8(w[7] * initDifficulty(w, 4) + (1 - w[7]) * next), 1, 10);
}

function recallStability(w, d, s, r, g) {
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return round8(
    clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, S_MAX)
  );
}

function forgetStability(w, d, s, r) {
  return round8(clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX));
}

function shortTermStability(w, s, g) {
  let sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
  if (g >= 2) sinc = Math.max(sinc, 1);
  return round8(clamp(s * sinc, S_MIN, S_MAX));
}

/**
 * Next memory state.
 * mem: {stability, difficulty} or null for a new card; t: whole days since last review; g: 1..4.
 */
export function nextMemory(w, mem, t, g) {
  if (!mem || (!mem.stability && !mem.difficulty)) {
    return { stability: initStability(w, g), difficulty: clamp(initDifficulty(w, g), 1, 10) };
  }
  const { stability: s, difficulty: d } = mem;
  const r = retrievability(w, t, s);
  let ns;
  if (t === 0) ns = shortTermStability(w, s, g);
  else if (g === 1) {
    const fail = forgetStability(w, d, s, r);
    const minS = round8(s / Math.exp(w[17] * w[18]));
    ns = clamp(minS, S_MIN, fail);
  } else ns = recallStability(w, d, s, r, g);
  return { stability: ns, difficulty: nextDifficulty(w, d, g) };
}

/**
 * Approximate memory state for a card that has SM-2 history but no FSRS state.
 * Stability chosen so the current interval matches desired retention; difficulty
 * mapped linearly from ease (1.3 → 10, 2.5 → 5, ≥3.7 → 1).
 */
export function memoryFromSm2(w, ivlDays, easeFactor, retention) {
  const per = intervalFor(w, 1, retention);
  const s = clamp(Math.max(ivlDays, 1) / per, S_MIN, S_MAX);
  const ease = easeFactor > 0 ? easeFactor / 1000 : 2.5;
  const d = clamp(10 - ((ease - 1.3) * 5) / 1.2, 1, 10);
  return { stability: round8(s), difficulty: round8(d) };
}
