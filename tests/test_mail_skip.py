"""Fourteenth round, item 10: kinds of mail he has said no to are skipped by name, before anything
reaches the engine. All names are invented."""
import json

from harness.mail_dates import SKIP_FILE, MailDates, skip_kinds, skipped_kind
from fake_caldav import no_network  # noqa: F401  (autouse)
from fakes import SyncExecutor
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL, TZ
from test_family_gmail import g  # noqa: F401
from test_mail_dates import RETURN, Box, Engine, msg, read

AMAZON = "Amazon.com <auto-confirm@amazon.com>"
SAVE = "Last day to manage your Subscribe & Save delivery"
SAVE_DAY = [{"what": "Subscribe & Save cutoff", "date": "2026-11-26", "kind": "deadline"}]
RETURN_SUBJECT = "Your Amazon.com order: return window closes Nov 26"


def rig_skip(g, tmp_path, messages, answers=None, writes=True):
    g.box = Box(messages)
    g.engine = Engine(answers)
    g.writes = writes
    g.md = MailDates(g.ledger, g.client, SyncExecutor(), address=lambda: GMAIL,
                     password=lambda: "abcdefghijklmnop", engine_fn=lambda: g.engine,
                     writes_on=lambda: g.writes, tz=TZ, mailbox=g.box, sleep=lambda s: None,
                     family=g.fa.client, data_dir=str(tmp_path))
    g.md.bind(1)
    return g


def rows(g):
    return g.ledger.db.execute("SELECT what, state FROM mail_dates").fetchall()


def test_amazon_delivery_management_is_a_kind_by_name():
    kinds = skip_kinds(None)
    assert kinds[0]["name"] == "Amazon delivery management"
    for subject in (SAVE, "Review your upcoming Subscribe & Save delivery",
                    "Your delivery day has changed", "Manage your subscription: next delivery Dec 2"):
        assert skipped_kind(AMAZON, subject, kinds) == "Amazon delivery management", subject
    assert skipped_kind(AMAZON, RETURN_SUBJECT, kinds) == ""
    assert skipped_kind(AMAZON, "Your order of PC parts has shipped", kinds) == ""
    assert skipped_kind("Shop <orders@shop.example>", SAVE, kinds) == ""   # the sender counts too


def test_a_subscribe_and_save_mail_is_skipped_before_the_engine(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, SAVE, "Last day to manage: Nov 26", sender=AMAZON)], {SAVE: SAVE_DAY})
    read(g)
    assert g.engine.asked == [] and g.box.texts_read == []     # never sent, its text never read
    assert rows(g) == []                                       # no card, no entry
    assert g.google.live() == {}
    assert not [r for r in g.ledger.db.execute("SELECT text FROM outbox") if "Subscribe" in (r[0] or "")]
    assert g.ledger.get_meta("mail_last_uid") == "1"           # and it's done with, not read again


def test_an_order_return_window_from_the_same_sender_still_goes_through(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, SAVE, sender=AMAZON), msg(2, RETURN_SUBJECT, sender=AMAZON)],
             {SAVE: SAVE_DAY, RETURN_SUBJECT: RETURN})
    read(g)
    assert g.engine.asked == [RETURN_SUBJECT]
    assert [r["what"] for r in rows(g)] == ["Amazon return: PC parts"]
    assert len(g.google.live()) == 1


def test_a_kind_named_in_the_file_is_skipped_without_a_build(g, tmp_path):
    subject = "Your Paws Club points statement"
    (tmp_path / SKIP_FILE).write_text(json.dumps({"skip": [
        {"name": "Pet shop points", "from": ["pawsclub.example"], "subject": ["points statement"]}]}))
    rig_skip(g, tmp_path, [msg(1, subject, sender="Paws Club <news@pawsclub.example>")],
             {subject: [{"what": "Points expire", "date": "2026-11-26", "kind": "deadline"}]})
    read(g)
    assert g.engine.asked == [] and rows(g) == []
    assert [k["name"] for k in skip_kinds(str(tmp_path))] == ["Amazon delivery management", "Pet shop points"]


def test_a_file_that_cant_be_read_keeps_the_built_in_kinds(tmp_path):
    (tmp_path / SKIP_FILE).write_text("{not json")
    assert [k["name"] for k in skip_kinds(str(tmp_path))] == ["Amazon delivery management"]
    (tmp_path / SKIP_FILE).write_text(json.dumps([{"name": "No words"}, "odd", {"from": ["x"], "subject": ["y"]}]))
    assert [k["name"] for k in skip_kinds(str(tmp_path))] == ["Amazon delivery management"]


def test_the_digest_never_mentions_skipped_mail(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, SAVE, sender=AMAZON), msg(2, RETURN_SUBJECT, sender=AMAZON)],
             {SAVE: SAVE_DAY, RETURN_SUBJECT: RETURN}, writes=False)
    read(g)
    line = g.md.digest_line()
    assert "Amazon return: PC parts" in line                    # what went through is said
    assert "Subscribe" not in line and "Save" not in line and "manage" not in line.casefold()
    assert not g.ledger.db.execute("SELECT 1 FROM events WHERE kind='mail_passed'").fetchall()
