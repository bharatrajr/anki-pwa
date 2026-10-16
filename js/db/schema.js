// IndexedDB schema and versioned migrations.
// RULE: never edit a migration that has shipped; add a new one with a higher version.
// Each migration must keep existing data (no deleteObjectStore on user data).

export const DB_NAME = 'anki-pwa';

export const MIGRATIONS = [
  {
    version: 1,
    upgrade(db) {
      db.createObjectStore('meta', { keyPath: 'key' });
      const nt = db.createObjectStore('notetypes', { keyPath: 'id' });
      nt.createIndex('name', 'name');
      const decks = db.createObjectStore('decks', { keyPath: 'id' });
      decks.createIndex('name', 'name');
      db.createObjectStore('presets', { keyPath: 'id' });

      const notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('guid', 'guid', { unique: true });
      notes.createIndex('ntid', 'ntid');
      notes.createIndex('tags', 'tags', { multiEntry: true });
      notes.createIndex('mod', 'mod');

      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      // Primary scheduling index: "what is due in deck X" is a key-range scan.
      cards.createIndex('did_queue_due', ['did', 'queue', 'due']);
      cards.createIndex('nid', 'nid');
      cards.createIndex('queue', 'queue');
      cards.createIndex('flags', 'flags');
      cards.createIndex('mod', 'mod');

      const revlog = db.createObjectStore('revlog', { keyPath: 'id' });
      revlog.createIndex('cid', 'cid');

      db.createObjectStore('media', { keyPath: 'name' });
    },
  },
];

export const STORES = ['meta', 'notetypes', 'decks', 'presets', 'notes', 'cards', 'revlog', 'media'];
