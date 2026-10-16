// Built-in note types, matching Anki's stock definitions (rslib/src/notetype/stock.rs)
// so that exports look like ordinary Anki note types.

import { newId } from '../util/hash.js';

export const KIND_STANDARD = 0;
export const KIND_CLOZE = 1;

const BASIC_CSS = `.card {
    font-family: arial;
    font-size: 20px;
    line-height: 1.5;
    text-align: center;
    color: black;
    background-color: white;
}
`;
const CLOZE_CSS = `${BASIC_CSS}.cloze {
    font-weight: bold;
    color: blue;
}
.nightMode .cloze {
    color: lightblue;
}
`;

function field(name, ord) {
  return { name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, description: '' };
}
function template(name, ord, qfmt, afmt) {
  return { name, ord, qfmt, afmt, bqfmt: '', bafmt: '', did: null };
}

const ANSWER_SEP = '\n\n<hr id=answer>\n\n';

export function stockNotetypes() {
  const now = Date.now();
  return [
    {
      id: newId(), name: 'Basic', kind: KIND_STANDARD, sortf: 0, mod: now, css: BASIC_CSS,
      fields: [field('Front', 0), field('Back', 1)],
      templates: [template('Card 1', 0, '{{Front}}', `{{FrontSide}}${ANSWER_SEP}{{Back}}`)],
      stock: 'basic',
    },
    {
      id: newId(), name: 'Basic (and reversed card)', kind: KIND_STANDARD, sortf: 0, mod: now, css: BASIC_CSS,
      fields: [field('Front', 0), field('Back', 1)],
      templates: [
        template('Card 1', 0, '{{Front}}', `{{FrontSide}}${ANSWER_SEP}{{Back}}`),
        template('Card 2', 1, '{{Back}}', `{{FrontSide}}${ANSWER_SEP}{{Front}}`),
      ],
      stock: 'basic-reversed',
    },
    {
      id: newId(), name: 'Basic (type in the answer)', kind: KIND_STANDARD, sortf: 0, mod: now, css: BASIC_CSS,
      fields: [field('Front', 0), field('Back', 1)],
      templates: [template('Card 1', 0, '{{Front}}\n\n{{type:Back}}', `{{Front}}${ANSWER_SEP}{{type:Back}}`)],
      stock: 'basic-typing',
    },
    {
      id: newId(), name: 'Cloze', kind: KIND_CLOZE, sortf: 0, mod: now, css: CLOZE_CSS,
      fields: [field('Text', 0), field('Back Extra', 1)],
      templates: [template('Cloze', 0, '{{cloze:Text}}', '{{cloze:Text}}<br>\n{{Back Extra}}')],
      stock: 'cloze',
    },
  ];
}

/** Map of field name → value for a note under its note type. */
export function fieldMap(notetype, note) {
  const map = {};
  notetype.fields.forEach((f, i) => { map[f.name] = note.fields[i] ?? ''; });
  return map;
}
