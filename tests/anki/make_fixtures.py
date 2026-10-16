"""Build the Anki test fixtures in tests/fixtures with the official Anki library.

    python -m venv .venv && .venv/bin/pip install anki
    .venv/bin/python tests/anki/make_fixtures.py

Creates a small collection (Basic, reversed, cloze, typing notes; media; subdecks;
an FSRS preset; some reviews, a suspended and a flagged card) and exports it as:
  modern.apkg / modern.colpkg   (collection.anki21b, zstd, protobuf media list)
  legacy.apkg / legacy.colpkg   ("support older Anki versions": collection.anki21, JSON media)
plus expected.json describing what an importer should find.
"""
import json, os, sys, tempfile, time
from anki.collection import Collection, ExportAnkiPackageOptions
from anki.scheduler.v3 import CardAnswer

OUT = os.path.join(os.path.dirname(__file__), '..', 'fixtures')
os.makedirs(OUT, exist_ok=True)

tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, 'collection.anki2'))
col.set_config('fsrs', True)

# Media: a tiny PNG and a fake mp3.
png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')
img = col.media.write_data('dot.png', png)
snd = col.media.write_data('hello.mp3', b'ID3fake-mp3-data')

lang = col.decks.id('Telugu::Words')
gram = col.decks.id('Telugu::Grammar')

# A custom preset for Telugu::Words.
conf = col.decks.add_config_returning_id('Telugu preset')
c = col.decks.get_config(conf)
c['new']['perDay'] = 15
c['rev']['perDay'] = 150
c['new']['delays'] = [2.0, 15.0]
c['lapse']['delays'] = [5.0]
c['lapse']['leechFails'] = 6
c['desiredRetention'] = 0.87
col.decks.update_config(c)
d = col.decks.get(lang)
d['conf'] = conf
d['desc'] = 'Everyday words'
col.decks.save(d)

def add(model, fields, deck, tags=()):
    m = col.models.by_name(model)
    n = col.new_note(m)
    for i, v in enumerate(fields):
        n.fields[i] = v
    n.tags = list(tags)
    col.add_note(n, deck)
    return n

n1 = add('Basic', ['dog', f'kukka <img src="{img}">'], lang, ['animals'])
n2 = add('Basic (and reversed card)', ['water', f'neeru [sound:{snd}]'], lang, ['nature', 'telugu::core'])
n3 = add('Cloze', ['{{c1::Hyderabad}} is the capital of {{c2::Telangana::state}}', 'extra'], gram)
n4 = add('Basic (type in the answer)', ['one', 'okati'], gram)
n5 = add('Basic', ['cat', 'pilli'], lang)

# Study a few cards with the v3 scheduler (FSRS on).
col.decks.select(lang)
answered = 0
for _ in range(4):
    qc = col.sched.get_queued_cards()
    if not qc.cards:
        break
    top = qc.cards[0]
    card = col.get_card(top.card.id)
    card.start_timer()
    states = top.states
    ans = col.sched.build_answer(card=card, states=states, rating=CardAnswer.EASY)
    col.sched.answer_card(ans)
    answered += 1

# Suspend one card, flag another.
cards5 = n5.cards()
col.sched.suspend_cards([cards5[0].id])
c4 = n4.cards()[0]
c4.set_user_flag(3)
col.update_card(c4)

expected = {
    'notes': col.note_count(),
    'cards': col.card_count(),
    'revlog': col.db.scalar('select count() from revlog'),
    'answered': answered,
    'decks': sorted(dn.name for dn in col.decks.all_names_and_ids()),
    'media': sorted(['dot.png', 'hello.mp3']),
    'guids': {n.fields[0]: n.guid for n in [n1, n2, n3, n4, n5]},
    'preset': {'name': 'Telugu preset', 'newPerDay': 15, 'revPerDay': 150, 'learnSteps': [2, 15], 'relearnSteps': [5], 'leechThreshold': 6, 'retention': 0.87},
    'suspended': cards5[0].id,
    'flagged': c4.id,
    'reviewCards': col.db.list('select id from cards where type = 2'),
    'crt': col.crt,
}
col.close(downgrade=False)
col = Collection(os.path.join(tmp, 'collection.anki2'))

def export_apkg(path, legacy):
    opts = ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True, with_media=True, legacy=legacy)
    col.export_anki_package(out_path=path, options=opts, limit=None)

export_apkg(os.path.join(OUT, 'modern.apkg'), False)
export_apkg(os.path.join(OUT, 'legacy.apkg'), True)
col.export_collection_package(os.path.join(OUT, 'modern.colpkg'), include_media=True, legacy=False)
col = Collection(os.path.join(tmp, 'collection.anki2'))
col.export_collection_package(os.path.join(OUT, 'legacy.colpkg'), include_media=True, legacy=True)

with open(os.path.join(OUT, 'expected.json'), 'w') as f:
    json.dump(expected, f, indent=1)
print(json.dumps(expected, indent=1))
