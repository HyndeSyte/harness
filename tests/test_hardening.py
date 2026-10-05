"""Second layers: checks that exist even though an earlier layer usually
catches the same thing first. Each is tested directly, so a regression in
one layer can't hide behind the other."""
import os
from datetime import timedelta

import pytest

from harness import approvals, choices, daily, render, telegram
from harness.config import Config
from harness.telegram import Incoming
from conftest import OWNER, msg
from fakes import FakeBot


def inc(**kw):
    base = dict(update_id=9, kind="callback", user_id=OWNER, chat_id=OWNER,
                chat_type="private", message_id=50, callback_id="q", callback_data=None)
    base.update(kw)
    return Incoming(**base)


def bound_choice(ledger):
    with ledger.tx() as db:
        n = choices.mint(ledger, kind="rule_undo", target="R1", chat_id=OWNER, ttl_s=600,
                         db=db)
    choices.bind(ledger, n, 50)
    return n


@pytest.mark.parametrize("who", [dict(user_id=999), dict(chat_id=999),
                                 dict(chat_type="group")])
def test_choices_check_the_tapper_themselves(ledger, who):
    n = bound_choice(ledger)
    v = choices.verify_and_consume(ledger, inc(callback_data=f"c:{n}", **who),
                                   owner_user_id=OWNER)
    assert not v.ok and v.reason == "not his tap"


def test_choices_and_approvals_refuse_message_id_zero(ledger):
    with ledger.tx() as db:
        n = choices.mint(ledger, kind="rule_undo", target="R1", chat_id=OWNER, ttl_s=600,
                         db=db)
    with pytest.raises(ValueError):
        choices.bind(ledger, n, 0)
    # a real, unbound approval: id 0 (or a bool) must not bind it
    from conftest import msg as _msg
    _, [job] = telegram.poll_once(FakeBot([[_msg(1, "hold")]]), ledger, OWNER, timeout=0)
    with ledger.tx() as db:
        ledger.transition(job, "running", db=db)
        pid = approvals.create_proposal(ledger, job_id=job, effect_type="calendar_hold",
                                        params={"start": "2026-10-23T14:00:00-04:00",
                                                "duration_min": 30},
                                        policy_version="p1", ttl_s=600, db=db)
    nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=OWNER, ttl_s=600)
    for bad in (0, True, -5):
        with pytest.raises(ValueError):
            approvals.bind_message(ledger, nonce, bad)
    row = ledger.db.execute("SELECT message_id FROM approvals WHERE nonce=?", (nonce,)).fetchone()
    assert row["message_id"] is None
    assert ledger.db.execute("SELECT message_id FROM choices WHERE nonce=?",
                             (n,)).fetchone()["message_id"] is None


def test_an_expired_change_cannot_be_approved_even_unread(tmp_path):
    from datetime import datetime, timezone
    from harness.vault import Vault

    class C:
        t = datetime(2026, 10, 20, tzinfo=timezone.utc)

        def __call__(self):
            return self.t
    clock = C()
    v = Vault(str(tmp_path / "s.json"), clock=clock)
    v.set_key("openai_api_key", "sk-proj-" + "A" * 40, by="x")
    cid = v.request_change("openai_api_key", "sk-proj-" + "B" * 40, by="x")
    clock.t += timedelta(minutes=16)
    assert v.resolve_change(cid, "approve") == "That request expired. Nothing changed."
    assert v.get("openai_api_key") == "sk-proj-" + "A" * 40


def test_empty_polls_are_recorded_at_most_once_a_minute(ledger, clock):
    ledger.ingest([], None)
    first = ledger.get_meta("last_poll_success")
    clock.advance(seconds=30)
    ledger.ingest([], None)
    assert ledger.get_meta("last_poll_success") == first
    clock.advance(seconds=31)
    ledger.ingest([], None)
    assert ledger.get_meta("last_poll_success") != first


def test_a_pairing_code_from_a_group_does_not_pair(ledger, tmp_path, clock):
    from test_controller import Rig
    r = Rig(ledger, tmp_path, clock, paired=False)
    code = r.vault.new_pairing_code()
    r.updates(msg(1, f"/start {code}", chat=-100555, chat_type="group"))
    r.c.tick()
    assert r.vault.owner() is None
    r.updates(msg(2, f"/start {code}", is_bot=True))
    r.c.tick()
    assert r.vault.owner() is None


def test_digest_says_what_it_does_not_know(ledger, clock):
    cfg = Config(owner_user_id=OWNER, stage="S1")
    ledger.ingest([], None)
    with ledger.tx() as db:
        ledger.set_meta("integrity_since", ledger.get_meta("last_poll_success"), db)
        ledger.set_meta("paused_at", ledger.get_meta("last_poll_success"), db)
    ledger.add_spend(provider="anthropic", model="m", purpose="job", input_tokens=0,
                     output_tokens=0, usd=35.0)
    d = daily.gather(ledger, cfg, paused=True, notes=["a webhook is set on the bot"])
    assert d.state == "attention"
    assert "canary: did not run" in d.text
    assert "stopped since" in d.text and "/resume" in d.text
    assert "a webhook is set on the bot" in d.text
    assert "Claude $5.00 of $40 left this month" in d.text


def test_environment_scrub():
    from harness import __main__ as main
    os.environ["SUPERVISOR_TOKEN"] = "x" * 20
    main.scrub_environment()
    assert "SUPERVISOR_TOKEN" not in os.environ


def test_fit_closes_tags_and_never_splits_an_entity():
    long = "<b>" + "a &amp; b " * 900 + "</b>"
    out = render.fit(long, "\n\n<i>job abc</i>")
    assert render.units(out) <= render.TELEGRAM_LIMIT
    body = out.split("\n… (cut to fit)")[0]
    assert body.endswith("</b>")
    assert not __import__("re").search(r"&[a-z]*$", body.removesuffix("</b>"))


def test_fit_counts_what_telegram_counts():
    emoji = "🙂" * 2100            # 2 UTF-16 units each: 4200 units, 2100 characters
    out = render.fit(emoji)
    assert render.units(out) <= render.TELEGRAM_LIMIT and "(cut to fit)" in out


def test_idle_reset_only_after_six_quiet_days(ledger, clock):
    from harness.ledger import iso
    with ledger.tx() as db:
        ledger.set_meta("telegram_offset", "50", db)
        ledger.set_meta("last_update_received", iso(clock() - timedelta(days=5)), db)
    bot = FakeBot()
    telegram.poll_once(bot, ledger, OWNER, timeout=0)
    assert bot.offsets[-1] == 50


def test_a_cut_never_lands_inside_an_entity():
    # 4096 - 15 (the cut marker) = 4081 = 5 * 816 + 1: a naive cut ends on "&"
    out = render.fit("&amp;" * 2000)
    body = out.split("\n… (cut to fit)")[0]
    assert body.endswith("&amp;") and render.units(out) <= render.TELEGRAM_LIMIT
