// Read aloud (Web Speech synthesis), voice grading (speech recognition) and keeping the
// screen awake. Speech recognition needs Chrome/Android with internet and microphone
// permission; on iOS it is missing or unreliable, so the review screen falls back to taps.

const synth = globalThis.speechSynthesis;
const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const ttsSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
export const recognitionSupported = !!Recognition;

/** Voices, waiting for them to load (Chrome loads them asynchronously). */
export function getVoices() {
  if (!ttsSupported) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener?.('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

function pickVoice(voices, voiceURI, lang) {
  if (lang) {
    const l = lang.toLowerCase();
    const exact = voices.find((v) => v.lang.toLowerCase().replace('_', '-') === l);
    const base = voices.find((v) => v.lang.toLowerCase().startsWith(l.split('-')[0]));
    // A language named by the card template wins over the chosen voice if they differ.
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen && chosen.lang.toLowerCase().startsWith(l.split('-')[0])) return chosen;
    if (exact || base) return exact || base;
  }
  return voices.find((v) => v.voiceURI === voiceURI) || null;
}

let speakToken = 0;
/** Speak text; resolves when finished, cancelled or failed. */
export async function speak(text, { voiceURI = '', rate = 1, lang = null } = {}) {
  if (!ttsSupported || !text) return;
  const token = ++speakToken;
  synth.cancel();
  const voices = await getVoices();
  if (token !== speakToken) return;
  // Long text is split into sentences: some engines stop after ~200 characters.
  const parts = String(text).match(/[^.!?。！？\n]+[.!?。！？]?/g) || [text];
  for (const part of parts) {
    if (token !== speakToken) return;
    if (!part.trim()) continue;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(part.trim());
      const v = pickVoice(voices, voiceURI, lang);
      if (v) { u.voice = v; u.lang = v.lang; } else if (lang) u.lang = lang;
      u.rate = rate;
      u.onend = u.onerror = () => resolve();
      synth.speak(u);
      // Safety net: some engines never fire onend.
      setTimeout(resolve, Math.max(4000, part.length * 180 / rate));
    });
  }
}

export function stopSpeaking() {
  speakToken++;
  if (ttsSupported) synth.cancel();
}

// ---------- voice commands ----------

const WORDS = {
  again: ['again', 'fail', 'failed', 'forgot', 'forgotten', 'wrong', 'one', '1', 'won', 'repeat'],
  hard: ['hard', 'difficult', 'two', '2', 'too', 'to', 'tough'],
  good: ['good', 'correct', 'right', 'yes', 'okay', 'ok', 'three', '3', 'got it', 'great'],
  easy: ['easy', 'four', '4', 'for', 'simple', 'trivial'],
  show: ['show', 'answer', 'reveal', 'flip', 'turn', 'show answer', 'next'],
  undo: ['undo', 'go back'],
  repeat: ['say again', 'read again', 'replay'],
};

/** Map a transcript to a command, or null. Checks the last words first ("um, good"). */
export function matchCommand(transcript, allowed) {
  const t = String(transcript || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [cmd, words] of Object.entries(WORDS)) {
    if (!allowed.includes(cmd)) continue;
    if (words.some((w) => w.includes(' ') && t.includes(w))) return cmd;
  }
  const tokens = t.split(' ').reverse();
  for (const tok of tokens) {
    for (const [cmd, words] of Object.entries(WORDS)) {
      if (allowed.includes(cmd) && words.includes(tok)) return cmd;
    }
  }
  return null;
}

/**
 * Listen once for one of the allowed commands. Returns a controller {stop()}.
 * onCommand(cmd) is called once; onState('listening'|'idle'|'error', message) reports status.
 */
export function listenFor(allowed, { lang = 'en-US', onCommand, onState }) {
  if (!Recognition) { onState?.('error', 'Voice commands are not supported in this browser.'); return { stop() {} }; }
  let stopped = false;
  let rec = null;
  let restarts = 0;
  const start = () => {
    if (stopped) return;
    rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.continuous = false;
    rec.onstart = () => onState?.('listening');
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        for (const alt of e.results[i]) {
          const cmd = matchCommand(alt.transcript, allowed);
          if (cmd) { stopped = true; try { rec.abort(); } catch {} onState?.('idle'); onCommand(cmd); return; }
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopped = true; onState?.('error', 'Microphone permission was denied.'); }
      else if (e.error === 'network') { stopped = true; onState?.('error', 'Voice commands need an internet connection.'); }
    };
    rec.onend = () => {
      // Recognition stops after silence; keep listening while this card is shown.
      if (!stopped && restarts++ < 60) setTimeout(start, 250);
      else if (!stopped) onState?.('idle');
    };
    try { rec.start(); } catch { setTimeout(start, 500); }
  };
  start();
  return { stop() { stopped = true; try { rec?.abort(); } catch {} onState?.('idle'); } };
}

// ---------- screen wake lock ----------

let lock = null;
let wanted = false;
async function acquire() {
  if (!wanted || lock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { lock = null; }
}
const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };

export function keepAwake(on) {
  wanted = !!on;
  if (wanted) { acquire(); document.addEventListener('visibilitychange', onVisible); }
  else { document.removeEventListener('visibilitychange', onVisible); lock?.release().catch(() => {}); lock = null; }
}
export const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
