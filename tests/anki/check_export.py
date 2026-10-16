"""Import files exported by AnkiPWA into real Anki and check what arrives.

    ANKI_OUT=/tmp/out npm test
    .venv/bin/python tests/anki/check_export.py /tmp/out
"""
import os, sys, tempfile
from anki.collection import Collection, ImportAnkiPackageRequest, ImportAnkiPackageOptions
from anki.import_export_pb2 import ImportAnkiPackageUpdateCondition as Cond

out = sys.argv[1]
failures = []
def check(cond, msg):
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond:
        failures.append(msg)

def fresh():
    return Collection(os.path.join(tempfile.mkdtemp(), 'collection.anki2'))

def import_apkg(col, path, with_scheduling=True):
    opts = ImportAnkiPackageOptions(with_scheduling=with_scheduling, with_deck_configs=True, merge_notetypes=True,
                                    update_notes=Cond.IMPORT_ANKI_PACKAGE_UPDATE_CONDITION_IF_NEWER,
                                    update_notetypes=Cond.IMPORT_ANKI_PACKAGE_UPDATE_CONDITION_IF_NEWER)
    return col.import_anki_package(ImportAnkiPackageRequest(package_path=path, options=opts))

# 1. Everything, with progress.
col = fresh()
col.set_config('fsrs', True)
res = import_apkg(col, os.path.join(out, 'pwa-all.apkg'))
check(col.note_count() == 7, f'apkg: 7 notes imported (got {col.note_count()})')
names = sorted(d.name for d in col.decks.all_names_and_ids())
check('Telugu::Phrases' in names and 'Telugu::Words' in names, f'apkg: decks {names}')
reviewed = col.db.list('select id from cards where type = 2')
check(len(reviewed) >= 4, f'apkg: review cards keep their state ({len(reviewed)})')
learning = col.db.scalar('select count() from cards where queue in (1, 3)')
check(learning >= 1, f'apkg: learning cards from the phone keep their state ({learning})')
mem = col.db.scalar("select count() from cards where data like '%\"s\":%'")
check(mem >= 4, f'apkg: FSRS memory state present on {mem} cards')
revs = col.db.scalar('select count() from revlog')
check(revs >= 7, f'apkg: review history imported ({revs})')
check(col.media.have('pwa.png') and col.media.have('dot.png') and col.media.have('hello.mp3'), 'apkg: media files imported')
conf = col.decks.config_dict_for_deck_id(col.decks.id_for_name('Telugu::Words'))
check(conf['name'] == 'Telugu preset' and conf['new']['perDay'] == 15, f"apkg: preset kept ({conf['name']}, {conf['new']['perDay']}/day)")
# The scheduler can study it.
col.decks.select(col.decks.id_for_name('Telugu'))
q = col.sched.get_queued_cards()
check(q is not None, 'apkg: Anki scheduler builds a queue')
card = col.get_card(reviewed[0])
check(card.memory_state is not None and card.memory_state.stability > 0, f'apkg: card memory state readable by Anki ({card.memory_state})')
due_days = card.due - col.sched.today
check(0 < due_days < 40, f'apkg: review card due in {due_days} days')
# Re-import: nothing duplicated.
import_apkg(col, os.path.join(out, 'pwa-all.apkg'))
check(col.note_count() == 7, 'apkg: re-import does not duplicate notes')
col.close()

# 2. One deck without progress.
col = fresh()
import_apkg(col, os.path.join(out, 'pwa-phrases-noprogress.apkg'), with_scheduling=False)
check(col.note_count() == 2, f'apkg (no progress): 2 notes ({col.note_count()})')
check(col.db.scalar('select count() from cards where type != 0') == 0, 'apkg (no progress): all cards new')
check(col.media.have('pwa.png'), 'apkg (no progress): media')
col.close()

# 3. Whole collection.
target = os.path.join(tempfile.mkdtemp(), 'collection.anki2')
col = Collection(target)
col.close(downgrade=False)
from anki._backend import RustBackend
backend = RustBackend()
media_folder = target.replace('.anki2', '.media'); os.makedirs(media_folder, exist_ok=True)
backend.import_collection_package(col_path=target, backup_path=os.path.join(out, 'pwa.colpkg'), media_folder=media_folder, media_db=target.replace('.anki2', '.mdb'))
col = Collection(target)
check(col.note_count() == 7, f'colpkg: 7 notes ({col.note_count()})')
check(col.db.scalar('select count() from revlog') >= 7, 'colpkg: review history')
check(os.path.exists(os.path.join(media_folder, 'pwa.png')), 'colpkg: media')
check(col.get_config('fsrs', False) is True, 'colpkg: FSRS enabled')
check(col.decks.id_for_name('Telugu::Phrases') is not None, 'colpkg: decks')
col.close()

# 4. Plain text notes.
col = fresh()
from anki.collection import ImportCsvRequest
meta = col.get_csv_metadata(path=os.path.join(out, 'pwa-notes.txt'), delimiter=None)
check(meta.guid_column == 1 and meta.tags_column > 0, f'txt: Anki reads the header (guid col {meta.guid_column}, tags col {meta.tags_column})')
col.import_csv(ImportCsvRequest(path=os.path.join(out, 'pwa-notes.txt'), metadata=meta))
check(col.note_count() == 7, f'txt: 7 notes ({col.note_count()})')
col.close()

print('\n%d failure(s)' % len(failures))
sys.exit(1 if failures else 0)
