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

/** All media filenames referenced by a field (img src, [sound:], object/audio src). */
export function mediaRefs(s) {
  const out = new Set(soundRefs(s));
  String(s || '').replace(/<(?:img|audio|source|video)[^>]*?src=["']?([^"'>\s]+)["']?/gi, (_, f) => {
    if (!/^(?:https?:|data:|blob:)/i.test(f)) out.add(decodeEntities(f));
  });
  return [...out];
}
