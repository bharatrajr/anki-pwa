// String-level HTML helpers that work in both the browser and Node (no DOM).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Remove tags (and <style>/<script> contents) and decode entities. */
export function stripHtml(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  );
}

/**
 * Anki's strip_html_preserving_media_filenames (rslib/src/text.rs): image tags are
 * replaced by their filename, then other HTML is stripped. Used for the note checksum
 * and the sort field.
 */
export function stripHtmlPreservingMediaFilenames(s) {
  const withNames = String(s || '').replace(/<img[^>]*?src=["']?([^"'>\s]+)["']?[^>]*>/gi, ' $1 ');
  return stripHtml(withNames);
}

/** True if a field has no meaningful content (Anki's field_is_empty: whitespace, <br>, &nbsp;). */
export function fieldIsEmpty(s) {
  return /^(?:[\s ]|<\/?(?:br|div)\s*\/?>|&nbsp;)*$/i.test(String(s || ''));
}

/** Extract [sound:...] filenames. */
export function soundRefs(s) {
  const out = [];
  String(s || '').replace(/\[sound:([^\]]+)\]/g, (_, f) => out.push(f));
  return out;
}

// ---------- audio / TTS tags ("av tags", as Anki calls them) ----------
// [sound:file.mp3]                                   audio file
// [anki:tts lang=en_US speed=1.2]text[/anki:tts]     Anki's TTS tag ({{tts en_US:Field}} renders to this)
// <tts service="android" voice="en_US">text</tts>    AnkiDroid's older TTS tag
// Tags copied onto the answer by {{FrontSide}} are marked "-front" so they are shown
// (and replayable) but not played again automatically, like Anki.

const AV_RE = /\[sound(-front)?:([^\]]+)\]|\[anki:tts(-front)?([^\]]*)\]([\s\S]*?)\[\/anki:tts\]|<tts\b(?![^>]*\bdata-front\b)([^>]*)>([\s\S]*?)<\/tts>/gi;

function attr(src, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>\\]]+))`, 'i').exec(src || '');
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}
const normLang = (l) => (l ? l.replace('_', '-') : null);

/** Ordered audio items of a side: {kind:'sound', file} | {kind:'tts', text, lang, speed}. */
export function avRefs(html) {
  const out = [];
  for (const m of String(html || '').matchAll(AV_RE)) {
    if (m[2] !== undefined) { if (!m[1]) out.push({ kind: 'sound', file: m[2] }); continue; }
    if (m[5] !== undefined) {
      if (m[3]) continue;
      const text = ttsText(m[5]);
      if (text) out.push({ kind: 'tts', text, lang: normLang(attr(m[4], 'lang')), speed: parseFloat(attr(m[4], 'speed')) || 1 });
      continue;
    }
    const text = ttsText(m[7]);
    if (text) out.push({ kind: 'tts', text, lang: normLang(attr(m[6], 'voice') || attr(m[6], 'lang')), speed: 1 });
  }
  return out;
}

/** Spoken form of TTS tag content: no HTML, cloze gaps read as "blank". */
export function ttsText(html) {
  return stripHtml(String(html || '').replace(/\[\.\.\.\]|\[…\]/g, ' blank ').replace(/<br\s*\/?>/gi, ', ')).replace(/\s+/g, ' ').trim();
}

/** Mark av tags so they don't autoplay (used for {{FrontSide}} on the answer). */
export function markFrontAv(html) {
  return String(html || '')
    .replace(/\[sound:/g, '[sound-front:')
    .replace(/\[anki:tts(?!-front)/g, '[anki:tts-front')
    .replace(/<tts\b(?![^>]*\bdata-front\b)/gi, '<tts data-front');
}

/** Remove Anki TTS tags (hidden on screen) from text meant for reading or searching. */
export function stripAnkiTts(html) {
  return String(html || '').replace(/\[anki:tts(-front)?[^\]]*\][\s\S]*?\[\/anki:tts\]/gi, ' ');
}

/** All media filenames referenced by a field (img src, [sound:], object/audio src). */
export function mediaRefs(s) {
  const out = new Set(soundRefs(s));
  String(s || '').replace(/<(?:img|audio|source|video)[^>]*?src=["']?([^"'>\s]+)["']?/gi, (_, f) => {
    if (!/^(?:https?:|data:|blob:)/i.test(f)) out.add(decodeEntities(f));
  });
  return [...out];
}
