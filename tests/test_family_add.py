"""The Family calendar add, end to end with doubles: from his message to one event.

These run on Windows as well as Linux. Shipped prompt and status code uses
strftime codes Windows doesn't have, so the tests stub the prompt where a job
starts; the prompt's own text is checked separately.
"""
import json
import queue
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, commands, daily, effects, family_add, prompts, render, schema
from harness.config import Config
from fakes import receive, own, TestController as Controller
from harness.family_add import FamilyAdd
from harness.ledger import iso
from harness.runner import Runner
from harness.vault import FIELDS, LABELS, Vault, VaultError
from conftest import OWNER, cb, msg
from fake_caldav import (APP_PASSWORD, APPLE_ID, FAMILY_PATH, FAMILY_URL, OTHER_URL, FakeICloud,
                         no_network, props)  # noqa: F401  (no_network is autouse)
from fakes import FakeBot, FakeEngine, SyncExecutor, result

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18
EVENT = {"title": "Dentist", "start": "2026-10-27T15:00:00-04:00",
         "end": "2026-10-27T16:00:00-04:00", "location": ""}


def at_least(stage):
    order = ("S0", "S1", "S2", "S3")
    return lambda s: order.index(stage) >= order.index(s)


def proposal(**params):
    return result({"type": "proposal", "effect_type": "family_event_add",
                   "params": {**EVENT, **params}, "summary": "ignored by the card"})


@pytest.fixture(autouse=True)
def plain_prompt(monkeypatch):
    monkeypatch.setattr(prompts, "system_prompt", lambda **kw: "system")


class Rig:
    def __init__(self, ledger, tmp_path, clock, *, credentials=True, stage="S1"):
        self.ledger = ledger
        self.clock = clock
        self.tmp_path = tmp_path
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        if credentials:
            self.vault.set_key("family_apple_id", APPLE_ID, by="Owner")
            self.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
            self.vault.set_key("family_calendar_url", FAMILY_URL, by="Owner")
        own(self.vault, OWNER)
        self.bot = FakeBot()
        self.claude = FakeEngine("claude")
        self.icloud = FakeICloud()
        self.stage = stage
        self.uid = 100
        self.mark_daily_done()
        self.start()

    def start(self):
        """A fresh process over the same ledger and vault."""
        client = caldav.FamilyCalDav(self.icloud, lambda: (
            self.vault.get("family_apple_id"), self.vault.get("family_app_password"),
            self.vault.get("family_calendar_url")))
        self.fa = FamilyAdd(self.ledger, client, tz="America/New_York", policy_version="p1",
                            model="test-model", creds_stamp=self.vault.family_stamp)
        self.requests = queue.Queue()
        self.c = Controller(ledger=self.ledger, vault=self.vault, api=self.bot,
                            engines={"claude": self.claude}, executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage=self.stage),
                            sleep=lambda s: None, monotonic=lambda: 0.0, status_box={},
                            requests=self.requests, poll_timeout=0, family_add=self.fa)
        self.c.startup()

    def mark_daily_done(self):
        today = self.clock().astimezone(ZoneInfo("America/New_York")).date().isoformat()
        with self.ledger.tx() as db:
            self.ledger.set_meta("canary_date", today, db)
            self.ledger.set_meta("digest_date", today, db)
            self.ledger.set_meta("last_poll_success", iso(self.clock()), db)

    def advance(self, **kw):
        """Time passes with the bot in touch, and today's digest already out."""
        self.clock.advance(**kw)
        self.mark_daily_done()

    def tick(self):
        self.c.tick()

    def say(self, text, **kw):
        self.uid += 1
        self.bot.batches.append([msg(self.uid, text, **kw)])
        self.tick()

    def ask(self, *items, **params):
        self.claude.script = [proposal(**params)]
        self.say("add dentist Tuesday 3pm")

    def press(self, sent, label, **kw):
        self.uid += 1
        _, _, buttons, mid = sent
        data = next(d for row in buttons for t, d in row if t == label)
        self.bot.batches.append([cb(self.uid, data, message_id=mid, **kw)])
        self.tick()

    def press_data(self, data, mid, **kw):
        self.uid += 1
        self.bot.batches.append([cb(self.uid, data, message_id=mid, **kw)])
        self.tick()

    def last(self):
        return self.bot.sent[-1]

    def with_button(self, label):
        return next(s for s in reversed(self.bot.sent)
                    if s[2] and any(t == label for row in s[2] for t, _ in row))

    def texts(self):
        return self.bot.texts()

    def turn_on(self):
        self.ask()
        self.press(self.last(), "Turn on")
        assert self.fa.enabled()
        self.bot.sent.clear()
        self.icloud.log.clear()

    def add_one(self, **params):
        """One event, approved and receipted."""
        self.ask(**params)
        if not self.fa.loosened():
            self.press(self.with_button("Approve"), "Approve")
        return self.with_button("Undo")

    def jobs(self, state):
        return self.ledger.jobs_in(state)

    def receipt(self, job_id):
        return json.loads(self.ledger.receipts(job_id)[-1]["detail"])


@pytest.fixture
def rig(ledger, tmp_path, clock):
    return Rig(ledger, tmp_path, clock)


@pytest.fixture
def on(rig):
    rig.turn_on()
    return rig


# -- 1. the effect: what a model can say ------------------------------------------------

def parse(params, stage="S1"):
    return schema.parse_output({"type": "proposal", "effect_type": "family_event_add",
                                "params": params, "summary": "s"},
                               stage_at_least=at_least(stage))


def test_a_model_may_propose_it():
    out = parse(EVENT)
    assert out.body["params"]["title"] == "Dentist"
    assert parse({k: v for k, v in EVENT.items() if k != "location"}).type == "proposal"


@pytest.mark.parametrize("extra", ["calendar", "attendees", "organizer", "alarm", "recurrence",
                                   "rrule", "marker", "uid", "url"])
def test_everything_else_is_fixed_in_code(extra):
    with pytest.raises(schema.OutputError, match="undeclared"):
        parse({**EVENT, extra: "x"})


@pytest.mark.parametrize("change, why", [
    ({"start": "2026-10-27T15:00:00"}, "timezone"),
    ({"end": "2026-10-27T16:00:00"}, "timezone"),
    ({"start": "2026-10-27"}, "timezone"),
    ({"start": "tuesday"}, "ISO"),
    ({"end": "2026-10-27T15:00:00-04:00"}, "after the start"),
    ({"end": "2026-10-27T14:00:00-04:00"}, "after the start"),
    ({"title": "x" * 201}, "longer than 200"),
    ({"location": "x" * 201}, "longer than 200"),
    ({"title": "   "}, "blank"),
    ({"title": "a\r\nATTENDEE:mailto:x@example.com"}, "invisible or special"),
    ({"location": "a\nb"}, "invisible or special"),
    ({"title": "a\u202eb"}, "invisible or special"),
    ({"title": "a\ud83db"}, "invisible or special"),
    ({"title": 7}, "string"),
])
def test_bad_params_are_refused_whole(change, why):
    with pytest.raises(schema.OutputError, match=why):
        parse({**EVENT, **change})


def test_the_definition_fixes_the_calendar_and_no_people():
    f = effects.REGISTRY["family_event_add"].fixed
    assert f["calendar"] == "Family" and f["attendees"] == () and f["recurrence"] == ()
    assert f["organizer"] is None and f["alarms"] == () and f["marker"] == caldav.MARKER


def test_the_other_effects_stay_locked_at_s1_with_the_switch_on(on, ledger):
    bad = {"type": "proposal", "effect_type": "calendar_hold",
           "params": {"start": "2026-10-27T15:00:00-04:00", "duration_min": 30}, "summary": "s"}
    on.claude.script = [result(bad)]
    on.say("hold tuesday")
    assert "didn't fit the allowed shapes" in on.texts()[-1]
    mirror = {"type": "proposal", "effect_type": "work_mirror_copy",
              "params": {"op": "delete", "event_id": "m1" + "a" * 20}, "summary": "s"}
    on.claude.script = [result(mirror)]
    on.say("mirror")
    assert "didn't fit the allowed shapes" in on.texts()[-1]
    with pytest.raises(effects.ParamError):
        effects.lookup("calendar_hold", at_least("S1"))
    with pytest.raises(effects.ParamError):
        effects.lookup("work_mirror_copy", at_least("S1"), origin="controller")
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals WHERE effect_type!='family_event_add'"
                             ).fetchone()[0] == 0


def test_not_before_s1():
    with pytest.raises(schema.OutputError):
        parse(EVENT, stage="S0")


def test_only_this_shape_is_offered_when_it_is_wired():
    s = at_least("S1")
    without = prompts.output_schema(s)["properties"]["output"]["anyOf"]
    assert not [x for x in without if x["properties"]["type"]["enum"] == ["proposal"]]
    shape = prompts.output_schema(s, family_add=True)["properties"]["output"]["anyOf"]
    [p] = [x for x in shape if x["properties"]["type"]["enum"] == ["proposal"]]
    assert p["properties"]["effect_type"]["enum"] == ["family_event_add"]
    assert set(p["properties"]["params"]["properties"]) == {"title", "start", "end", "location"}
    assert p["additionalProperties"] is False


def test_the_real_prompt_describes_it_only_when_wired(monkeypatch):
    monkeypatch.undo()

    class Local:
        def strftime(self, _):
            return "a local time"

    class Now:
        def astimezone(self, _):
            return Local()
    kw = dict(now=Now(), tz="America/New_York", rules=[], stage_at_least=at_least("S1"))
    assert "family_event_add" not in prompts.system_prompt(**kw)
    text = prompts.system_prompt(**kw, family_add=True)
    assert "family_event_add" in text and "timezone offset" in text
    assert APP_PASSWORD not in text and "icloud" not in text.lower()


def test_a_runner_without_it_wired_fails_closed(ledger):
    r = Runner(ledger, Config(owner_user_id=OWNER, stage="S1"),
               {"claude": FakeEngine(script=[proposal()])}, SyncExecutor(),
               sleep=lambda s: None, monotonic=lambda: 0.0)
    _, [job] = receive(ledger, [msg(1, "add it")])
    r.start_pending(paused=False)
    r.collect()
    assert ledger.job(job)["state"] == "failed"
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0


# -- 2. the separate switch ---------------------------------------------------------------

def test_off_by_default_and_a_proposal_fails_closed_in_words(rig, ledger):
    assert not rig.fa.enabled()
    rig.ask()
    assert "is off, so nothing was added" in rig.texts()[-1]
    assert rig.icloud.log == []
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0
    [job] = rig.jobs("no_action")
    assert rig.receipt(job["id"])["reason"] == "family_add_off"


def test_off_with_no_credentials_says_what_is_missing_and_offers_no_button(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, credentials=False)
    r.ask()
    _, text, buttons, _ = r.last()
    assert "Harness page" in text and buttons is None


def test_only_his_tap_on_the_card_turns_it_on(rig):
    rig.ask()
    card = rig.last()
    data = card[2][0][0][1]
    mid = card[3]
    rig.press_data(data, mid, user=999, chat=999)
    assert not rig.fa.enabled()
    rig.press_data(data, mid + 1)
    assert not rig.fa.enabled()
    rig.claude.script = [result(text="ok")]
    rig.say("yes, turn it on")
    assert not rig.fa.enabled()
    rig.press_data(data, mid)
    assert rig.fa.enabled()
    assert "Each add shows you a card" in rig.texts()[-1]


def test_turning_it_on_expires(rig, clock):
    rig.ask()
    card = rig.last()
    rig.advance(minutes=16)
    rig.press(card, "Turn on")
    assert not rig.fa.enabled()


def test_the_switch_moves_nothing_else(on, ledger):
    assert on.c.config.stage == "S1" and not on.c.config.stage_at_least("S2")
    assert not on.fa.loosened()
    assert "stage" not in {r["key"] for r in ledger.db.execute("SELECT key FROM meta")}


def test_no_setting_page_or_rule_can_reach_the_switch(rig, ledger):
    from harness import rules
    assert not set(FIELDS) & set(family_add.MANAGED)
    for field in ("family_add_enabled", "family_add_loosened", "calendar"):
        with pytest.raises(rules.RuleError):
            rules.propose(ledger, {"rule_type": "drafting", "scope": "draft", "field": field,
                                   "value": "1", "literal": "x"}, job_id=None)


def test_a_reset_turns_it_all_off_again(on, ledger):
    on.add_one()
    ledger.set_meta(family_add.LOOSENED, json.dumps(on.fa._authority()))
    on.requests.put({"type": "reset", "by": "Owner"})
    on.tick()
    assert not on.fa.enabled() and not on.fa.loosened() and on.fa._bake()["n"] == 0


# -- 3. approval and the card -------------------------------------------------------------

def test_a_card_comes_first_and_only_the_tap_writes_one_event(on, ledger):
    on.ask()
    _, text, buttons, _ = on.last()
    assert [t for t, _ in buttons[0]] == ["Approve", "Decline"]
    assert on.icloud.log == [] and not on.icloud.events
    assert "Add to the Family calendar?" in text
    on.press(on.last(), "Approve")
    assert on.icloud.methods() == ["PROPFIND", "PUT"]
    assert len(on.icloud.family()) == 1
    [job] = on.jobs("executed")
    assert on.receipt(job["id"])["http_status"] == 201


def test_the_card_is_plain_code_in_local_time_with_weekday_and_date(on):
    on.ask(start="2026-10-27T19:00:00Z", end="2026-10-27T20:00:00Z", location="Main St")
    text = on.last()[1]
    assert "Tue Oct 27, 2026, 3:00 PM to 4:00 PM EDT" in text
    assert "Where: Main St" in text
    assert "ignored by the card" not in text
    assert "No invitees, no repeat" in text


def test_the_card_handles_a_day_change_and_a_clock_change():
    assert render.family_when("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00",
                              "America/New_York") == "Sun Nov 1, 2026, 1:30 AM to 1:30 AM EDT to EST"
    assert render.family_when("2026-10-27T23:00:00-04:00", "2026-10-28T09:05:00-04:00",
                              "America/New_York") == ("Tue Oct 27, 2026, 11:00 PM EDT to "
                                                      "Wed Oct 28, 2026, 9:05 AM EDT")
    assert render.family_when("2026-12-07T00:00:00-05:00", "2026-12-07T12:00:00-05:00",
                              "America/New_York") == "Mon Dec 7, 2026, 12:00 AM to 12:00 PM EST"


def test_model_text_on_the_card_and_receipt_is_escaped_and_defanged(on):
    evil = "<b>tap</b> /stop @someone"
    on.ask(title=evil, location="<i>x</i>")
    text = on.last()[1]
    assert "<b>tap" not in text and "&lt;b&gt;tap" in text
    assert "/stop" not in text and "@someone" not in text and "<i>x</i>" not in text
    on.press(on.with_button("Approve"), "Approve")
    receipt = on.with_button("Undo")[1]
    assert "<b>tap" not in receipt


def test_a_decline_writes_nothing(on):
    on.ask()
    on.press(on.last(), "Decline")
    assert on.icloud.log == [] and on.jobs("declined")


def test_a_second_tap_writes_nothing_more(on):
    on.ask()
    card = on.last()
    on.press(card, "Approve")
    on.press(card, "Approve")
    assert on.icloud.methods().count("PUT") == 1


def test_the_approval_is_consumed_before_the_remote_call(on, ledger):
    on.ask()
    seen = []
    on.icloud.before_write = lambda: seen.append(ledger.db.execute(
        "SELECT consumed_at FROM approvals").fetchone()["consumed_at"])
    on.press(on.last(), "Approve")
    assert seen and seen[0] is not None


def test_an_approved_add_is_refused_if_the_switch_went_off_since(on):
    on.ask()
    card = on.last()
    on.ledger.db.execute("DELETE FROM meta WHERE key=?", (family_add.ENABLED,))
    on.press(card, "Approve")
    assert on.icloud.log == []
    assert "is off, so nothing was added" in on.texts()[-1]


def test_a_tap_from_anyone_else_writes_nothing(on):
    on.ask()
    on.press(on.last(), "Approve", user=999, chat=999)
    assert on.icloud.log == [] and on.jobs("proposed")


def test_the_tap_is_bound_to_the_exact_parameters(on, ledger):
    on.ask()
    ledger.db.execute("UPDATE proposals SET params_json=?",
                      (json.dumps({**EVENT, "title": "Other"}),))
    on.press(on.last(), "Approve")
    assert on.icloud.log == [] and on.jobs("proposed")


def test_the_executor_checks_the_parameters_again(on, ledger):
    on.ask()
    on.press_data("noop", 1)            # an unrecognized tap changes nothing
    ledger.db.execute("UPDATE proposals SET state='approved', params_json=?",
                      (json.dumps({**EVENT, "title": "Other"}),))
    ledger.db.execute("UPDATE jobs SET state='approved' WHERE state='proposed'")
    on.tick()
    assert on.icloud.log == []
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "changed"


def test_an_old_offer_expires_and_stops_waiting(on, ledger):
    on.ask()
    card = on.last()
    on.advance(hours=13)
    on.tick()
    assert on.jobs("expired") and not on.jobs("proposed")
    on.press(card, "Approve")
    assert on.icloud.log == []
    assert any(a[1] == "That offer expired." for a in on.bot.answers)


def test_an_event_now_in_the_past_is_refused_at_execution(on, ledger, clock):
    on.ask(start="2026-10-21T10:00:00-04:00", end="2026-10-21T11:00:00-04:00")
    on.advance(hours=2)
    on.press(on.last(), "Approve")
    assert on.icloud.log == []
    assert "already passed, so nothing was added" in on.texts()[-1]
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "past"
    assert on.fa.problem() == ""


# -- 5. outcomes ------------------------------------------------------------------------

def test_the_receipt_comes_from_the_response_and_has_undo(on):
    on.ask()
    on.press(on.last(), "Approve")
    _, text, buttons, _ = on.with_button("Undo")
    assert "Added to the Family calendar" in text and "HTTP 201" in text
    assert "Tue Oct 27, 2026, 3:00 PM to 4:00 PM EDT" in text
    [job] = on.jobs("executed")
    assert on.receipt(job["id"])["uid"] == caldav.uid_for(
        on.ledger.db.execute("SELECT id FROM proposals").fetchone()["id"])


def test_a_lost_response_is_unknown_and_is_not_retried(on, ledger):
    on.ask()
    on.icloud.drop_response_next = True
    on.press(on.last(), "Approve")
    text = on.texts()[-1]
    assert "don't know whether that was added" in text and "Check the Family calendar" in text
    assert "Added to the Family calendar" not in text
    assert on.icloud.methods().count("PUT") == 1
    on.tick()
    on.tick()
    assert on.icloud.methods().count("PUT") == 1
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "family_unknown"
    assert not on.jobs("executed")


def test_a_server_error_is_unknown_too(on):
    on.ask()
    on.icloud.status_after_write = 500
    on.press(on.last(), "Approve")
    assert "don't know whether" in on.texts()[-1]


def test_a_refused_write_is_said_with_its_status_and_no_undo(on):
    on.ask()
    on.icloud.force_status = 403
    on.press(on.last(), "Approve")
    _, text, buttons, _ = on.last()
    assert "Not added" in text and "HTTP 403" in text and buttons is None
    assert not on.icloud.events


def test_no_etag_at_all_means_no_undo_button_and_says_so(on, monkeypatch):
    on.ask()
    monkeypatch.setattr(on.fa.client, "create",
                        lambda *a: caldav.Outcome("ok", 201, None))
    on.press(on.last(), "Approve")
    _, text, buttons, _ = on.last()
    assert "can't offer Undo" in text and buttons is None


class Crash(BaseException):
    """The process dies mid-request (as the stop signal does)."""


def test_a_restart_during_the_write_is_loud_and_never_retried(on, ledger):
    on.add_one()
    assert on.fa._bake()["n"] == 1
    on.bot.sent.clear()
    on.icloud.log.clear()
    on.ask(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    card = on.last()

    def die():
        raise Crash()
    on.icloud.before_write = die
    with pytest.raises(Crash):
        on.press(card, "Approve")
    assert ledger.db.execute("SELECT state FROM family_adds ORDER BY created_at DESC, rowid DESC"
                             ).fetchone()["state"] == "sending"
    on.start()
    on.bot.batches.append([])
    on.tick()
    assert any("don't know whether that was added" in t for t in on.texts())
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "family_unknown"
    assert on.icloud.methods().count("PUT") == 1
    assert "outcome is unknown" in on.fa.problem() and on.fa._bake()["n"] == 0


def test_a_restart_after_the_tap_before_the_write_fails_and_says_nothing_was_sent(on, ledger):
    on.ask()
    ledger.db.execute("UPDATE proposals SET state='approved'")
    ledger.db.execute("UPDATE jobs SET state='approved' WHERE state='proposed'")
    on.start()
    assert on.icloud.log == []
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "interrupted"
    on.tick()
    assert any("restarted before it wrote" in t for t in on.texts())


# -- 6. undo ------------------------------------------------------------------------------

def path_of(rig):
    [(path, _)] = rig.icloud.family().items()
    return path


def test_undo_deletes_only_that_event_once(on):
    other = on.icloud.seed(f"{FAMILY_PATH}someone-else.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    card = on.add_one()
    on.press(card, "Undo")
    assert "Undone" in on.texts()[-1]
    assert list(on.icloud.family()) == [f"{FAMILY_PATH}someone-else.ics"]
    assert on.icloud.family()[f"{FAMILY_PATH}someone-else.ics"][0] == other
    on.press(card, "Undo")
    assert on.icloud.methods().count("DELETE") == 1


def test_a_second_undo_request_is_nothing_at_any_later_state(on, ledger):
    card = on.add_one()
    pid = ledger.db.execute("SELECT proposal_id FROM family_adds").fetchone()["proposal_id"]
    on.press(card, "Undo")
    assert on.fa.on_choice("family_add_undo", pid) == "There's nothing to undo there."
    assert ledger.db.execute("SELECT undo_state FROM family_adds").fetchone()[0] == "undone"
    on.tick()
    assert on.icloud.methods().count("DELETE") == 1


def test_undo_refuses_when_someone_edited_it(on):
    card = on.add_one()
    on.icloud.human_edit(path_of(on), "Dentist", "Dentist with Pat")
    on.press(card, "Undo")
    assert "changed since I wrote it" in on.texts()[-1]
    assert "DELETE" not in on.icloud.methods() and len(on.icloud.family()) == 1
    assert on.last()[2] is None                  # no fresh button after that


def test_undo_of_something_already_deleted_deletes_nothing(on):
    card = on.add_one()
    del on.icloud.events[path_of(on)]
    on.press(card, "Undo")
    assert "any more" in on.texts()[-1] and "DELETE" not in on.icloud.methods()


def test_undo_with_a_lost_answer_is_unknown_and_offers_nothing_more(on):
    card = on.add_one()
    on.icloud.drop_response_next = True
    on.press(card, "Undo")
    _, text, buttons, _ = on.last()
    assert "don't know whether that was undone" in text and buttons is None
    assert on.icloud.methods().count("DELETE") == 1


def test_a_rejected_password_on_undo_keeps_the_undo_offered(on):
    card = on.add_one()
    on.vault.set_key("family_app_password", "zzzz-zzzz-zzzz-zzzz", by="Owner")
    on.press(card, "Undo")
    assert "Not undone: iCloud rejected the password" in on.last()[1]
    fresh = on.last()
    assert fresh[2]
    on.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
    on.press(fresh, "Undo")
    assert "Undone" in on.texts()[-1] and not on.icloud.family()


def test_undo_expires(on):
    card = on.add_one()
    on.advance(days=8)
    on.press(card, "Undo")
    assert "DELETE" not in on.icloud.methods()


def test_a_restart_during_the_undo_is_loud_and_never_retried(on):
    card = on.add_one()

    def die():
        raise Crash()
    on.icloud.before_write = die
    with pytest.raises(Crash):
        on.press(card, "Undo")
    on.start()
    on.tick()
    assert any("don't know whether that was undone" in t for t in on.texts())
    assert on.icloud.methods().count("DELETE") == 1


# -- 7. credentials ------------------------------------------------------------------------

def test_the_vault_keeps_them_like_keys(tmp_path):
    v = Vault(str(tmp_path / "s.json"))
    assert {"family_apple_id", "family_app_password", "family_calendar_url"} <= set(FIELDS)
    v.set_key("family_calendar_url", FAMILY_URL, by="Owner")
    v.set_key("family_app_password", APP_PASSWORD, by="Owner")
    assert v.key_status()["family_calendar_url"] and v.get("family_app_password") == APP_PASSWORD
    own(v, 7)
    cid = v.request_change("family_calendar_url", OTHER_URL, by="Owner")
    assert v.get("family_calendar_url") == FAMILY_URL      # only his tap applies it
    v.resolve_change(cid, "approve")
    assert v.get("family_calendar_url") == OTHER_URL


@pytest.mark.parametrize("field, value", [
    ("family_calendar_url", "http://p99-caldav.icloud.com/1/calendars/a/"),
    ("family_calendar_url", "https://caldav.evil.example/1/calendars/a/"),
    ("family_calendar_url", "https://p99-caldav.icloud.com.evil.example/1/a/"),
    ("family_app_password", "my-real-apple-password"),
    ("family_apple_id", "not an address"),
])
def test_the_wrong_thing_is_refused_without_being_echoed(tmp_path, field, value):
    with pytest.raises(VaultError) as e:
        Vault(str(tmp_path / "s.json")).set_key(field, value, by="Owner")
    assert value not in str(e.value)


def test_the_page_never_shows_them_and_shows_inputs_as_passwords(tmp_path):
    from harness.setup_web import SetupApp, render_page
    v = Vault(str(tmp_path / "s.json"))
    v.set_key("family_apple_id", APPLE_ID, by="Owner")
    v.set_key("family_app_password", APP_PASSWORD, by="Owner")
    v.set_key("family_calendar_url", FAMILY_URL, by="Owner")
    page = render_page(SetupApp(v, {"stage": "S1"}, queue.Queue()), "u1", "Owner")
    for secret in (APPLE_ID, APP_PASSWORD, FAMILY_URL, "icloud.com/"):
        assert secret not in page
    for field in ("family_apple_id", "family_app_password", "family_calendar_url"):
        assert f'type="password" name="{field}"' in page
        assert LABELS[field] in page


def all_text(rig):
    """Everything durable or visible that isn't the vault."""
    rows = []
    for table in ("outbox", "outbound", "receipts", "events", "meta", "family_adds", "proposals"):
        for r in rig.ledger.db.execute(f"SELECT * FROM {table}"):
            rows.append(json.dumps([str(x) for x in tuple(r)]))
    rows += rig.texts() + [str(c["system"]) + str(c["user"]) for c in rig.claude.calls]
    return "\n".join(rows)


@pytest.mark.parametrize("failure", ["none", "auth", "unknown", "mismatch"])
def test_credentials_are_never_in_the_ledger_the_thread_or_model_input(on, failure):
    card = None
    if failure == "none":
        card = on.add_one()
        on.press(card, "Undo")
    else:
        on.ask()
        if failure == "auth":
            on.icloud.force_status = 401
        elif failure == "unknown":
            on.icloud.drop_response_next = True
        else:
            on.icloud.names[FAMILY_PATH] = "Other"
        on.press(on.last(), "Approve")
    on.claude.script = [result(text="ok")]
    on.say("what happened?")
    text = all_text(on)
    for secret in (APP_PASSWORD, APPLE_ID, FAMILY_URL, FAMILY_PATH, "icloud.com"):
        assert secret not in text


# -- 8. network -------------------------------------------------------------------------------

def test_the_built_app_gates_its_transport_on_the_saved_host(tmp_path, monkeypatch):
    from harness import __main__ as main
    from harness.net import CalDavTransport, TransportError
    made = {}

    class Spy(CalDavTransport):
        def __init__(self, allowed_host, **kw):
            super().__init__(allowed_host, **kw)
            made["t"] = self
    monkeypatch.setattr(main, "CalDavTransport", Spy)
    monkeypatch.setattr(main, "serve", lambda *a, **k: None)
    monkeypatch.setattr(main.family, "serve", lambda *a, **k: None)
    controller, _, _ = main.build(str(tmp_path))
    try:
        t = made["t"]

        class NoSocket:
            def open(self, req, timeout=None):
                raise AssertionError("this test must never reach the network")
        t._opener = NoSocket()
        assert t.allowed_host() == ""           # nothing saved: no host at all
        with pytest.raises(TransportError):
            t.request("GET", FAMILY_URL)
        controller.vault.set_key("family_calendar_url", FAMILY_URL, by="Owner")
        assert t.allowed_host() == "p99-caldav.icloud.com"
        controller.vault.set_key("family_calendar_url", OTHER_URL.replace("p99", "p7"), by="Owner")
        assert t.allowed_host() == "p7-caldav.icloud.com"
        assert controller.family_add is not None and not controller.family_add.enabled()
    finally:
        controller.executor.shutdown(wait=False)
        controller.ledger.db.close()


# -- 9. the bake-in ---------------------------------------------------------------------------

def days_and_adds(rig, adds, days):
    for i in range(adds):
        rig.add_one(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    rig.advance(days=days)
    rig.bot.batches.append([])
    rig.tick()


def ask_cards(rig):
    return [s for s in rig.bot.sent if "Stop checking each" in s[1]]


def test_ten_adds_and_fourteen_days_bring_one_card_with_the_record(on):
    days_and_adds(on, 10, 14)
    [card] = ask_cards(on)
    assert "10 approved and added" in card[1] and "14 days" in card[1]
    assert "0 undone, 0 failed, 0 unknown" in card[1]
    assert "Nothing else changes" in card[1]
    assert not on.fa.loosened()


@pytest.mark.parametrize("adds, days", [(9, 30), (10, 13), (40, 13)])
def test_whichever_comes_later(on, adds, days):
    days_and_adds(on, adds, days)
    assert ask_cards(on) == []


def test_it_arrives_once_days_catch_up_without_another_add(on):
    days_and_adds(on, 10, 13)
    assert ask_cards(on) == []
    on.advance(days=1)
    on.tick()
    assert len(ask_cards(on)) == 1


def test_the_card_is_not_sent_twice_in_a_week_even_across_a_restart(on):
    days_and_adds(on, 10, 14)
    on.tick()
    on.add_one(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    on.advance(days=6)
    on.tick()
    on.start()
    on.tick()
    assert len(ask_cards(on)) == 1


def test_nothing_changes_until_he_taps(on):
    days_and_adds(on, 10, 14)
    on.ask(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    assert "Add to the Family calendar?" in on.last()[1]
    assert on.jobs("proposed")


def test_keep_checking_changes_nothing(on):
    days_and_adds(on, 10, 14)
    on.press(ask_cards(on)[0], "Something was off: keep checking")
    assert not on.fa.loosened() and "Each add still needs your tap" in on.texts()[-1]


def test_after_his_tap_adds_skip_approve_and_keep_receipt_undo_and_stop(on):
    days_and_adds(on, 10, 14)
    on.press(ask_cards(on)[0], "None wrong: stop checking")
    assert on.fa.loosened()
    on.icloud.log.clear()
    on.bot.sent.clear()
    on.ask(start="2027-01-06T15:00:00-05:00", end="2027-01-06T16:00:00-05:00")
    assert on.icloud.methods() == ["PROPFIND", "PUT"]
    assert not any("Add to the Family calendar?" in t for t in on.texts())
    receipt = on.with_button("Undo")
    assert "Added to the Family calendar" in receipt[1]
    on.press(receipt, "Undo")
    assert "Undone" in on.texts()[-1]
    on.say("/stop")
    on.icloud.log.clear()
    on.ask(start="2027-01-07T15:00:00-05:00", end="2027-01-07T16:00:00-05:00")
    assert on.icloud.log == []


def test_loosening_lets_nothing_else_through(on):
    on.ledger.set_meta(family_add.LOOSENED, json.dumps(on.fa._authority()))
    on.claude.script = [result({"type": "proposal", "effect_type": "calendar_hold",
                                "params": {"start": "2027-01-06T15:00:00-05:00",
                                           "duration_min": 30}, "summary": "s"})]
    on.say("hold it")
    assert on.icloud.log == []
    with on.ledger.tx() as db:
        job = on.ledger.db.execute("SELECT id FROM jobs ORDER BY created_at LIMIT 1").fetchone()
        db.execute("INSERT INTO proposals VALUES('x', ?, 'calendar_hold', '{}', 'h', 'p1',"
                   " 'proposed', 'a', 'b')", (job["id"],))
        assert on.fa.auto_approve("x", job["id"], db) is False
        assert db.execute("SELECT state FROM proposals WHERE id='x'").fetchone()[0] == "proposed"


def test_without_his_tap_a_proposal_cannot_be_auto_approved(on):
    on.ask()
    row = on.ledger.db.execute("SELECT id, job_id FROM proposals").fetchone()
    with on.ledger.tx() as db:
        assert on.fa.auto_approve(row["id"], row["job_id"], db) is False


def test_an_undo_restarts_the_count(on):
    card = on.add_one()
    for _ in range(8):
        on.add_one()
    on.press(card, "Undo")
    assert on.fa._bake()["n"] == 0 and on.fa._bake()["first"] is None
    days_and_adds(on, 1, 30)
    assert ask_cards(on) == [] and on.fa._bake()["n"] == 1


@pytest.mark.parametrize("failure", ["force", "lost", "mismatch"])
def test_a_failed_or_unknown_write_restarts_the_count(on, failure):
    for _ in range(9):
        on.add_one()
    on.ask()
    if failure == "force":
        on.icloud.force_status = 403
    elif failure == "lost":
        on.icloud.drop_response_next = True
    else:
        on.icloud.names[FAMILY_PATH] = "Other"
    on.press(on.with_button("Approve"), "Approve")
    assert on.fa._bake()["n"] == 0
    on.icloud.names[FAMILY_PATH] = "Family"
    on.advance(days=30)
    on.tick()
    assert ask_cards(on) == []


def test_a_new_count_can_earn_a_new_card_and_the_old_card_is_void(on):
    days_and_adds(on, 10, 14)
    old = ask_cards(on)[0]
    on.ask(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    on.icloud.force_status = 403
    on.press(on.with_button("Approve"), "Approve")
    on.press(old, "None wrong: stop checking")
    assert not on.fa.loosened() and "record changed" in on.texts()[-1]
    days_and_adds(on, 10, 14)
    assert len(ask_cards(on)) == 2
    on.press(ask_cards(on)[-1], "None wrong: stop checking")
    assert on.fa.loosened()


def test_a_refusal_before_any_write_does_not_restart_the_count(on):
    on.add_one()
    on.ask(start="2026-10-21T10:00:00-04:00", end="2026-10-21T11:00:00-04:00")
    on.advance(hours=2)
    on.press(on.with_button("Approve"), "Approve")
    assert "already passed" in on.texts()[-1] and on.fa._bake()["n"] == 1


def test_the_card_waits_while_stopped(on):
    days_and_adds(on, 10, 0)
    on.say("/stop")
    on.advance(days=14)
    on.tick()
    assert ask_cards(on) == []
    on.say("/resume")
    assert len(ask_cards(on)) == 1


# -- 10. the failure signal ----------------------------------------------------------------------

@pytest.mark.parametrize("arrange, thread, standing", [
    (lambda r: setattr(r.icloud, "force_status", 500), "don't know whether", "outcome is unknown"),
    (lambda r: setattr(r.icloud, "force_status", 403), "Not added", "last write failed"),
    (lambda r: r.vault.set_key("family_app_password", "zzzz-zzzz-zzzz-zzzz", by="Owner"),
     "rejected the password", "rejected the password"),
    (lambda r: r.icloud.names.__setitem__(FAMILY_PATH, "Other"), "name mismatch", "name mismatch"),
])
def test_a_failure_shows_in_the_thread_and_the_digest_until_a_write_succeeds(on, arrange, thread,
                                                                             standing):
    on.ask()
    arrange(on)
    on.press(on.last(), "Approve")
    assert thread in on.texts()[-1]
    assert standing in on.c.notes["family_add"]
    d = digest_now(on)
    assert d.state == "attention" and standing in d.text
    # it survives a restart
    on.start()
    assert standing in on.c.notes["family_add"]
    # and clears on a write that succeeds, not before
    on.claude.script = [result(text="ok")]
    on.say("still there?")
    assert standing in on.c.notes["family_add"]
    on.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
    on.icloud.names[FAMILY_PATH] = "Family"
    on.icloud.force_status = None
    on.add_one(start="2027-01-05T15:00:00-05:00", end="2027-01-05T16:00:00-05:00")
    assert "family_add" not in on.c.notes
    assert standing not in digest_now(on).text


def digest_now(rig):
    """The real composer. integrity_since is cleared because its date line uses a
    strftime code Windows lacks; that line isn't what is under test."""
    rig.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    return daily.gather(rig.ledger, Config(owner_user_id=OWNER, stage="S1"), paused=False,
                        notes=list(rig.c.notes.values()))


def test_the_controllers_digest_carries_it(on, clock):
    on.ask()
    on.icloud.force_status = 403
    on.press(on.last(), "Approve")
    on.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    on.ledger.set_meta("digest_date", "2000-01-01")
    clock.t = clock.t.replace(hour=20)
    on.mark_daily_done()
    on.ledger.set_meta("digest_date", "2000-01-01")
    on.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    on.c._daily(False)
    on.c.outbox.flush()
    assert "last write failed" in on.texts()[-1] and "Attention needed" in on.texts()[-1]


def test_a_successful_undo_counts_as_a_write_that_succeeded(on):
    card = on.add_one()
    with on.ledger.tx() as db:
        on.fa._set_problem(db, "failed")
    on.press(card, "Undo")
    assert on.fa.problem() == ""


def test_status_says_which_mode_it_is_in(rig):
    assert rig.fa.status_line() == "Family calendar adds: off"
    rig.turn_on()
    assert "each needs your tap (0 since" in rig.fa.status_line()
    rig.ledger.set_meta(family_add.LOOSENED, json.dumps(rig.fa._authority()))
    assert "skipping the Approve tap" in rig.fa.status_line()


# -- 11. /stop ----------------------------------------------------------------------------------

def test_stop_blocks_a_proposal(on):
    on.say("/stop")
    on.claude.calls.clear()
    on.claude.script = [proposal()]
    on.say("add it")          # stopped jobs never reach the model
    assert on.claude.calls == [] and on.icloud.log == []


def test_stop_arriving_while_a_model_was_working_blocks_the_card(on, ledger):
    from fakes import ManualExecutor
    ex = ManualExecutor()
    on.c.runner.executor = ex
    on.claude.script = [proposal()]
    on.say("add dentist")
    on.c.commands._stop("")
    ex.run_all()
    on.tick()
    assert on.icloud.log == [] and not on.jobs("proposed")
    assert "I'm stopped, so nothing was added" in on.texts()[-1]


def test_stop_blocks_an_approve_tap(on):
    on.ask()
    card = on.last()
    on.say("/stop")
    on.press(card, "Approve")
    assert on.icloud.log == []
    assert "I'm stopped, so nothing was added" in on.texts()[-1]
    on.say("/resume")
    on.tick()
    assert on.icloud.log == []             # no write waits behind a /stop


def test_stop_in_the_same_batch_as_the_tap_wins(on):
    on.ask()
    _, _, buttons, mid = on.last()
    on.uid += 2
    on.bot.batches.append([cb(on.uid - 1, buttons[0][0][1], message_id=mid),
                           msg(on.uid, "/stop")])
    on.tick()
    assert commands.is_paused(on.ledger) and on.icloud.log == []


def test_stop_blocks_an_undo_and_keeps_it_offered(on):
    card = on.add_one()
    on.say("/stop")
    on.icloud.log.clear()
    on.press(card, "Undo")
    assert on.icloud.log == [] and len(on.icloud.family()) == 1
    fresh = on.last()
    assert "didn't undo" in fresh[1] and fresh[2]
    on.say("/resume")
    on.press(fresh, "Undo")
    assert "Undone" in on.texts()[-1] and not on.icloud.family()


def test_the_digest_is_not_clear_while_waiting_on_a_card(on):
    on.ask()
    d = digest_now(on)
    assert "waiting for your tap" in d.text and "job " not in d.text


def test_event_text_is_exactly_what_was_approved(on):
    on.ask(title="Café, 3; A\\B", location="Main St, Room 2")
    on.press(on.last(), "Approve")
    ics = next(iter(on.icloud.family().values()))[1]
    p = props(ics)
    assert p["SUMMARY"] == ["SUMMARY:Café\\, 3\\; A\\\\B"]
    assert p["LOCATION"] == ["LOCATION:Main St\\, Room 2"]
    assert p["DTSTART"] == ["DTSTART:20261027T190000Z"]


# -- review round: the way back ---------------------------------------------------------------

STOP = "None wrong: stop checking"
KEEP = "Something was off: keep checking"
day = iter(range(1, 100000))


def fresh():
    """A start no other test event has, in standard time in the zone."""
    i = next(day)
    base = 60 * 15 * i
    d, h = 5 + (base // 86400) % 20, 9 + (base // 3600) % 8
    return {"start": f"2027-01-{d:02d}T{h:02d}:{(base // 60) % 60:02d}:00-05:00",
            "end": f"2027-01-{d:02d}T{h + 1:02d}:{(base // 60) % 60:02d}:00-05:00",
            "title": f"Event {i}"}


def count_up(rig, adds, days):
    for _ in range(adds):
        rig.add_one(**fresh())
    rig.advance(days=days)
    rig.bot.batches.append([])
    rig.tick()


@pytest.fixture
def loose(on):
    count_up(on, 10, 14)
    on.press(ask_cards(on)[-1], STOP)
    assert on.fa.loosened()
    on.bot.sent.clear()
    on.icloud.log.clear()
    return on


def test_loose_adds_write_with_no_card(loose):
    loose.ask(**fresh())
    assert loose.icloud.methods() == ["PROPFIND", "PUT"]
    assert not any("Add to the Family calendar?" in t for t in loose.texts())


def test_checkadds_restores_the_tap_at_once_and_says_so(loose):
    loose.say("/checkadds")
    assert not loose.fa.loosened() and "needs your Approve tap again" in loose.texts()[-1]
    loose.icloud.log.clear()
    loose.ask(**fresh())
    assert loose.icloud.log == [] and "Add to the Family calendar?" in loose.last()[1]


def test_checkadds_is_only_his(loose):
    loose.uid += 1
    loose.bot.batches.append([msg(loose.uid, "/checkadds", user=999, chat=999)])
    loose.tick()
    assert loose.fa.loosened()


def test_checkadds_works_while_stopped(loose):
    loose.say("/stop")
    loose.say("/checkadds")
    assert not loose.fa.loosened()


def test_checkadds_with_nothing_to_do_changes_nothing(on):
    on.add_one()
    before = on.fa._bake()
    on.say("/checkadds")
    assert "already needs your Approve tap" in on.texts()[-1] and on.fa._bake() == before


def test_checkadds_means_a_fresh_full_count(loose):
    loose.say("/checkadds")
    assert loose.fa._bake()["n"] == 0
    count_up(loose, 9, 30)
    assert ask_cards(loose) == []
    count_up(loose, 1, 0)
    assert len(ask_cards(loose)) == 1


def test_an_undo_after_loosening_restores_the_tap_and_says_why(loose):
    receipt = loose.add_one(**fresh())
    loose.press(receipt, "Undo")
    assert not loose.fa.loosened()
    assert any("you undid an event" in t and "Approve tap again" in t for t in loose.texts())
    assert loose.fa._bake()["n"] == 0


@pytest.mark.parametrize("arrange, why", [
    (lambda r: setattr(r.icloud, "force_status", 403), "a write failed"),
    (lambda r: setattr(r.icloud, "drop_response_next", True), "outcome is unknown"),
    (lambda r: setattr(r.icloud, "status_after_write", 500), "outcome is unknown"),
    (lambda r: r.icloud.names.__setitem__(FAMILY_PATH, "Other"), "a write failed"),
])
def test_a_failed_or_unknown_write_after_loosening_restores_the_tap(loose, arrange, why):
    arrange(loose)
    loose.ask(**fresh())
    assert not loose.fa.loosened()
    assert any(why in t and "Approve tap again" in t for t in loose.texts())
    assert loose.fa._bake()["n"] == 0


def test_a_crash_during_a_loose_write_restores_the_tap(loose):
    def die():
        raise Crash()
    loose.icloud.before_write = die
    with pytest.raises(Crash):
        loose.ask(**fresh())
    loose.start()
    assert not loose.fa.loosened()
    loose.tick()
    assert any("outcome is unknown" in t and "Approve tap again" in t for t in loose.texts())


def test_a_lost_undo_answer_keeps_the_tap_and_restarts(on):
    receipt = on.add_one()
    on.icloud.drop_response_next = True
    on.press(receipt, "Undo")
    assert on.fa._bake()["n"] == 0 and "unknown" in on.fa.problem()


def test_stop_stays_as_it_was_and_does_not_tighten(loose):
    loose.say("/stop")
    loose.claude.calls.clear()
    loose.ask(**fresh())
    assert loose.claude.calls == [] and loose.icloud.log == [] and loose.fa.loosened()


# -- review round: checks on every proposal ---------------------------------------------------

WRONG_OFFSET = {"start": "2026-11-10T15:00:00-04:00", "end": "2026-11-10T16:00:00-04:00"}


def test_a_wrong_offset_warns_on_the_card_with_the_time_it_means(on):
    on.ask(**WRONG_OFFSET)
    text = on.last()[1]
    assert "Check before approving" in text and "different UTC offset" in text
    assert "2:00 PM" in text                   # 19:00Z, what would really be written


def test_a_wrong_end_offset_warns_too(on):
    on.ask(start="2026-11-10T15:00:00-05:00", end="2026-11-10T17:00:00-04:00")
    assert "the end was written" in on.last()[1]


def test_a_warned_card_can_still_be_approved_by_his_tap(on):
    on.ask(**WRONG_OFFSET)
    on.press(on.last(), "Approve")
    assert on.icloud.methods() == ["PROPFIND", "PUT"]


def test_the_right_offset_on_each_side_of_the_clock_change_has_no_warning(on):
    on.ask(start="2026-10-27T15:00:00-04:00", end="2026-10-27T16:00:00-04:00")
    assert "Check before approving" not in on.last()[1]
    on.ask(start="2026-11-10T15:00:00-05:00", end="2026-11-10T16:00:00-05:00")
    assert "Check before approving" not in on.last()[1]


def test_utc_written_times_are_warned_about(on):
    on.ask(start="2026-11-10T20:00:00+00:00", end="2026-11-10T21:00:00+00:00")
    assert "different UTC offset" in on.last()[1]


@pytest.mark.parametrize("params, why", [
    ({"start": "2026-11-10T09:00:00-05:00", "end": "2026-11-11T09:01:00-05:00"}, "24 hours"),
    ({"start": "2027-10-21T10:00:00-04:00", "end": "2027-10-21T11:00:00-04:00"}, "a year"),
    ({"start": "2099-01-01T10:00:00-05:00", "end": "2099-01-01T11:00:00-05:00"}, "a year"),
])
def test_an_impossible_event_is_refused_in_words_with_a_receipt(on, params, why):
    on.ask(**params)
    _, text, buttons, _ = on.last()
    assert why in text and "I didn't add that" in text and buttons is None
    assert on.icloud.log == []
    assert on.receipt(on.jobs("no_action")[-1]["id"])["reason"] == "family_add_impossible"


def test_the_limits_themselves_are_allowed(on):
    on.ask(start="2026-11-10T09:00:00-05:00", end="2026-11-11T09:00:00-05:00")
    assert "Add to the Family calendar?" in on.last()[1]
    on.ask(start="2027-10-21T09:00:00-04:00", end="2027-10-21T09:30:00-04:00")
    assert "Add to the Family calendar?" in on.last()[1]


@pytest.mark.parametrize("params", [
    {"start": "2026-11-10T09:00:00-05:00", "end": "2026-11-11T10:00:00-05:00"},
    {"start": "2030-01-01T10:00:00-05:00", "end": "2030-01-01T11:00:00-05:00"},
])
def test_loose_an_impossible_event_never_writes(loose, params):
    loose.ask(**params)
    assert loose.icloud.log == [] and "I didn't add that" in loose.texts()[-1]


def test_an_impossible_event_is_refused_again_at_execution(on, ledger):
    on.ask()
    bad = {**EVENT, "end": "2026-10-29T15:00:00-04:00"}
    from harness.canonical import canonical_hash, canonical_json
    ledger.db.execute("UPDATE proposals SET params_json=?, params_hash=?, state='approved'",
                      (canonical_json(bad), canonical_hash(bad)))
    ledger.db.execute("UPDATE jobs SET state='approved' WHERE state='proposed'")
    on.tick()
    assert on.icloud.log == []
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "impossible"


def test_loose_a_wrong_offset_never_writes_and_gets_a_warned_card(loose):
    loose.ask(**WRONG_OFFSET)
    assert loose.icloud.log == []
    text = loose.last()[1]
    assert "Add to the Family calendar?" in text and "different UTC offset" in text
    loose.press(loose.last(), "Approve")
    assert loose.icloud.methods() == ["PROPFIND", "PUT"]


def test_a_same_title_same_start_is_a_suspected_duplicate(on):
    on.add_one()
    on.ask(title="  DENTIST ")
    assert "looks like a duplicate" in on.last()[1]


def test_the_same_instant_in_another_offset_is_still_a_duplicate(on):
    on.add_one()
    on.ask(start="2026-10-27T19:00:00+00:00", end="2026-10-27T20:00:00+00:00")
    assert "looks like a duplicate" in on.last()[1]


def test_an_open_card_counts_as_a_duplicate(on):
    on.ask()
    on.ask()
    assert "looks like a duplicate" in on.last()[1]


def test_an_unknown_write_counts_as_a_duplicate(on):
    on.ask()
    on.icloud.drop_response_next = True
    on.press(on.last(), "Approve")
    on.ask()
    assert "looks like a duplicate" in on.last()[1]


@pytest.mark.parametrize("change", [{"title": "Other"}, {"start": "2026-10-27T14:00:00-04:00"}])
def test_a_different_title_or_start_is_no_duplicate(on, change):
    on.add_one()
    on.ask(**change)
    assert "looks like a duplicate" not in on.last()[1]


def test_what_was_declined_expired_or_undone_is_no_duplicate(on):
    on.ask()
    on.press(on.last(), "Decline")
    on.ask()
    assert "looks like a duplicate" not in on.last()[1]
    on.advance(hours=13)
    on.tick()
    on.ask()
    assert "looks like a duplicate" not in on.last()[1]
    on.press(on.last(), "Approve")
    on.press(on.with_button("Undo"), "Undo")
    on.ask()
    assert "looks like a duplicate" not in on.last()[1]


def test_loose_a_duplicate_never_writes(loose):
    params = fresh()
    loose.ask(**params)
    loose.icloud.log.clear()
    loose.ask(**params)
    assert loose.icloud.log == [] and "looks like a duplicate" in loose.last()[1]
    assert loose.last()[2][0][0][0] == "Approve"


def test_at_most_five_tapless_adds_a_local_day_then_a_card(loose):
    for _ in range(5):
        loose.ask(**fresh())
    assert loose.icloud.methods().count("PUT") == 5
    loose.ask(**fresh())
    assert loose.icloud.methods().count("PUT") == 5
    assert "5 adds have already gone in without a tap today" in loose.last()[1]
    loose.press(loose.last(), "Approve")
    assert loose.icloud.methods().count("PUT") == 6      # his tap is not a tapless add


def test_the_daily_cap_counts_his_local_day(loose):
    for _ in range(5):
        loose.ask(**fresh())
    # 05:00 UTC is local midnight in EST, which is in force by now.
    loose.clock.t = loose.clock.t.replace(hour=4, minute=59) + __import__(
        "datetime").timedelta(days=1)
    loose.mark_daily_done()
    loose.ask(**fresh())
    assert "without a tap today" in loose.last()[1]
    loose.advance(minutes=2)
    loose.ask(**fresh())
    assert "without a tap today" not in loose.last()[1] and loose.bot.sent


def test_the_cap_does_not_touch_the_tap_stage(on):
    for _ in range(7):
        on.ask(**fresh())
        assert "without a tap today" not in on.last()[1]


# -- review round: the record on the bake-in card ----------------------------------------------

def test_the_card_shows_every_count_and_asks_plainly(on):
    on.ask(**fresh())
    on.press(on.last(), "Decline")
    on.ask(**fresh())
    on.press(on.last(), "Decline")
    on.ask(**fresh())
    on.advance(hours=13)
    on.tick()
    count_up(on, 10, 14)
    [card] = ask_cards(on)
    text = card[1]
    assert ("10 approved and added, 2 declined, 1 expired, 0 cancelled, 0 refused, 0 undone, "
            "0 failed, 0 unknown, 0 shown with a warning") in text
    assert "0 of those 10 added are no longer on the calendar" in text
    assert "Were any of these adds wrong?" in text
    assert [row[0][0] for row in card[2]] == [STOP, KEEP]


def test_declines_do_not_restart_the_count(on):
    on.add_one(**fresh())
    on.ask(**fresh())
    on.press(on.last(), "Decline")
    assert on.fa._bake()["n"] == 1


def test_events_deleted_by_hand_are_counted_as_missing_and_do_not_restart(on):
    count_up(on, 10, 13)
    for path in list(on.icloud.family())[:3]:
        del on.icloud.events[path]
    on.advance(days=1)
    on.tick()
    [card] = ask_cards(on)
    assert "3 of those 10 added are no longer on the calendar" in card[1]
    assert on.fa._bake()["n"] == 10


def test_the_missing_check_only_reads(on):
    count_up(on, 10, 13)
    on.icloud.log.clear()
    on.advance(days=1)
    on.tick()
    assert set(on.icloud.methods()) == {"PROPFIND", "GET"}
    assert on.icloud.methods().count("GET") == 10


@pytest.mark.parametrize("arrange", [
    lambda r: setattr(r.icloud, "down", True),
    lambda r: r.icloud.names.__setitem__(FAMILY_PATH, "Other"),
])
def test_a_check_that_cant_complete_says_so_and_offers_nothing_until_it_can(on, arrange):
    count_up(on, 10, 13)
    arrange(on)
    on.advance(days=1)
    on.tick()
    assert ask_cards(on) == []
    told = [s for s in on.bot.sent if "couldn't check the calendar" in s[1]]
    assert len(told) == 1 and told[0][2] is None
    on.tick()
    on.advance(hours=2)
    on.tick()
    assert ask_cards(on) == []
    assert len([s for s in on.bot.sent if "couldn't check the calendar" in s[1]]) == 1
    on.icloud.down = False
    on.icloud.names[FAMILY_PATH] = "Family"
    on.advance(hours=2)
    on.tick()
    assert len(ask_cards(on)) == 1


def test_it_does_not_hammer_icloud_while_the_check_is_failing(on):
    count_up(on, 10, 13)
    on.icloud.down = True
    on.advance(days=1)
    on.tick()
    on.icloud.log.clear()
    on.advance(minutes=30)
    on.tick()
    assert on.icloud.log == []


def test_earlier_counts_stay_on_the_record(on):
    receipt = on.add_one(**fresh())
    on.press(receipt, "Undo")
    on.advance(minutes=1)
    count_up(on, 10, 14)
    text = ask_cards(on)[0][1]
    assert "0 undone" in text
    assert "Before this count: 0 declined, 0 expired, 0 cancelled, 0 refused, 1 undone" in text


def test_something_off_keeps_the_tap_and_starts_the_count_over(on):
    count_up(on, 10, 14)
    on.press(ask_cards(on)[0], KEEP)
    assert not on.fa.loosened() and on.fa._bake()["n"] == 0
    assert "count starts over" in on.texts()[-1]


# -- review round: stale cards -------------------------------------------------------------------

def test_an_old_card_replayed_after_a_reset_does_nothing(on):
    count_up(on, 10, 14)
    old = ask_cards(on)[0]
    on.requests.put({"type": "reset", "by": "Owner"})
    on.tick()
    assert not on.fa.enabled() and not on.fa.loosened()
    # paired again, same account, same bot, and turned on again
    own(on.vault, OWNER)
    on.vault.set_key("family_apple_id", APPLE_ID, by="Owner")
    on.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
    on.vault.set_key("family_calendar_url", FAMILY_URL, by="Owner")
    on.tick()
    on.ask()
    on.press(on.with_button("Turn on"), "Turn on")
    assert on.fa.enabled()
    on.press(old, STOP)
    assert not on.fa.loosened()
    on.bot.sent.clear()
    on.icloud.log.clear()
    on.ask(**fresh())
    assert on.icloud.log == [] and "Add to the Family calendar?" in on.last()[1]


def test_even_a_live_nonce_from_before_a_reset_cannot_match_the_new_count(on):
    """The buttons are consumed on reset. This is the second layer on its own."""
    count_up(on, 10, 14)
    old_epoch = on.fa._bake()["epoch"]
    on.fa.forget()
    on.fa.on_choice("family_add_enable", "on")
    assert "nothing changed" in on.fa.on_choice("family_add_loosen", old_epoch)
    on.add_one(**fresh())
    new_epoch = on.fa._bake()["epoch"]
    assert new_epoch != old_epoch and len(new_epoch) == 16
    assert "nothing changed" in on.fa.on_choice("family_add_loosen", old_epoch)
    assert not on.fa.loosened()


def test_no_two_counts_ever_share_an_id(on):
    seen = set()
    for _ in range(3):
        on.add_one(**fresh())
        seen.add(on.fa._bake()["epoch"])
        with on.ledger.tx() as db:
            on.fa._restart_count(db)
        seen.add(on.fa._bake()["epoch"])
    assert len(seen) == 4       # first count's id, then one new id per restart
    assert all(e and len(e) == 16 for e in seen)
    first_restart = on.fa._bake()["epoch"]
    with on.ledger.tx() as db:
        on.fa._restart_count(db)
    assert on.fa._bake()["epoch"] != first_restart


def test_a_reset_consumes_every_open_family_button_and_only_those(on, ledger):
    from harness import choices
    count_up(on, 1, 0)
    with ledger.tx() as db:
        choices.mint(ledger, kind="rule_undo", target="R1", chat_id=OWNER, ttl_s=600, db=db)
    on.fa.forget()
    rows = {r["kind"]: r["consumed_at"] for r in ledger.db.execute(
        "SELECT kind, consumed_at FROM choices")}
    assert rows["family_add_undo"] is not None and rows["rule_undo"] is None


def test_a_loosen_tap_refuses_while_the_switch_is_off(on):
    count_up(on, 10, 14)
    epoch = on.fa._bake()["epoch"]
    on.ledger.db.execute("DELETE FROM meta WHERE key=?", (family_add.ENABLED,))
    assert "nothing changed" in on.fa.on_choice("family_add_loosen", epoch)
    assert not on.fa.loosened()


def test_a_reset_always_clears_loosening(loose):
    loose.requests.put({"type": "reset", "by": "Owner"})
    loose.tick()
    assert loose.ledger.get_meta(family_add.LOOSENED) is None


# -- review round: what the card shows is what is written ---------------------------------------

@pytest.mark.parametrize("field, text", [
    ("title", "RSVP https://evil.example/pay"),
    ("title", "see evil.example"),
    ("location", "10.0.0.1"),
    ("location", "zoom.example/j/1"),
])
def test_text_the_card_would_show_differently_is_refused(on, field, text):
    on.ask(**{field: text})
    _, said, buttons, _ = on.last()
    assert "link or web address" in said and buttons is None and on.icloud.log == []


def test_what_is_shown_is_the_exact_text(on):
    on.ask(title="Pat & Sam <lunch> @noon /now", location="Room 2")
    on.press(on.last(), "Approve")
    written = props(next(iter(on.icloud.family().values()))[1])["SUMMARY"][0]
    assert written == "SUMMARY:Pat & Sam <lunch> @noon /now"
    shown = render.plain(on.with_button("Undo")[1]).replace(render.WORD_JOINER, "")
    assert "Pat & Sam <lunch> @noon /now" in shown


@pytest.mark.parametrize("ch", ["\u2028", "\u2029", "\u0085", "\u200b", "\u200d", "\u200f",
                                "\u061c", "\ufeff", "\u00ad", "\u3164", "\u2800", "\u034f"])
@pytest.mark.parametrize("field", ["title", "location"])
def test_invisible_and_format_characters_are_refused(ch, field):
    with pytest.raises(schema.OutputError, match="invisible or special"):
        parse({**EVENT, field: f"Den{ch}tist"})


def test_a_title_of_only_a_zero_width_space_is_refused():
    with pytest.raises(schema.OutputError):
        parse({**EVENT, "title": "\u200b"})


def test_ordinary_text_passes():
    assert parse({**EVENT, "title": "Café \u65e5\u672c\u8a9e \U0001f642 Dr Smith's", "location": "Main St #2"})


@pytest.mark.parametrize("change", [
    {"start": "2026-10-27T15:00:30-04:00"},
    {"end": "2026-10-27T16:00:00.500000-04:00"},
])
def test_seconds_the_card_would_not_show_are_refused(change):
    with pytest.raises(schema.OutputError, match="whole minutes"):
        parse({**EVENT, **change})


# -- review round: every job ends in words and a receipt -------------------------------------------

@pytest.mark.parametrize("start, end", [
    ("9999-12-31T22:00:00-05:00", "9999-12-31T23:00:00-05:00"),
    ("0001-01-01T01:00:00+05:00", "0001-01-01T02:00:00+05:00"),
    ("2101-01-01T01:00:00-05:00", "2101-01-01T02:00:00-05:00"),
])
def test_an_extreme_year_ends_in_words_and_a_receipt(on, start, end):
    on.ask(start=start, end=end)
    assert on.receipt(on.jobs("no_action")[-1]["id"])["reason"] == "family_add_impossible"
    assert "the year has to be between" in on.texts()[-1] and not on.jobs("running")


def test_a_crash_writing_the_card_leaves_no_silent_proposal(on, ledger, monkeypatch):
    real = ledger.enqueue

    def die(**kw):
        if kw.get("kind") == "card":
            raise Crash()
        return real(**kw)
    monkeypatch.setattr(ledger, "enqueue", die)
    with pytest.raises(Crash):
        on.ask()
    monkeypatch.setattr(ledger, "enqueue", real)
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0
    assert on.jobs("running")
    on.start()
    on.tick()
    [job] = on.jobs("failed")
    assert on.receipt(job["id"])["reason"] == "interrupted"
    assert "restarted while working" in on.texts()[-1]


def test_an_expired_offer_says_so_and_has_a_receipt(on):
    on.ask()
    on.advance(hours=13)
    on.tick()
    assert "That offer expired, so nothing was added." in on.texts()[-1]
    [job] = on.jobs("expired")
    assert on.ledger.receipts(job["id"])[-1]["kind"] == "expired"


# -- review round: authority is tied to what it was earned on ---------------------------------------

@pytest.mark.parametrize("field, value", [
    ("family_calendar_url", "https://p7-caldav.icloud.com/1000002/calendars/shared-example/"),
    ("family_apple_id", "other@example.com"),
    ("family_app_password", "qrst-uvwx-yzab-cdef"),
])
def test_changing_a_credential_clears_loosening_and_restarts_the_count(loose, field, value):
    loose.add_one(**fresh())
    loose.advance(seconds=1)
    change = loose.vault.request_change(field, value, by="Owner")
    loose.vault.resolve_change(change, "approve")
    assert not loose.fa.loosened()                       # at once, before any tick
    loose.tick()
    assert loose.ledger.get_meta(family_add.LOOSENED) is None
    assert loose.fa._bake()["n"] == 0
    assert any("address, Apple ID or password changed" in t for t in loose.texts())


def test_changing_a_credential_restarts_a_count_that_was_not_yet_loose(on):
    on.add_one(**fresh())
    old = on.fa._bake()["epoch"]
    on.advance(seconds=1)
    on.vault.set_key("family_app_password", "qrst-uvwx-yzab-cdef", by="Owner")
    on.tick()
    assert on.fa._bake()["n"] == 0 and on.fa._bake()["epoch"] != old


def test_a_loose_add_right_after_a_change_gets_a_card_in_the_same_tick(loose):
    loose.advance(seconds=1)
    loose.vault.set_key("family_calendar_url", FAMILY_URL, by="Owner")
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods() and loose.jobs("proposed")


def test_nothing_changing_keeps_it_loose_across_a_restart(loose):
    loose.start()
    loose.tick()
    assert loose.fa.loosened()


@pytest.mark.parametrize("attr", ["policy_version", "model"])
def test_a_policy_or_model_change_restores_the_tap(loose, attr):
    setattr(loose.fa, attr, "something-new")
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods() and loose.jobs("proposed")
    assert loose.ledger.get_meta(family_add.LOOSENED) is None
    assert any("policy or the model changed" in t for t in loose.texts())
    assert loose.fa._bake()["n"] == 0


def test_a_policy_or_model_change_is_noticed_at_restart(loose):
    loose.fa.model = "something-new"
    loose.fa.reconcile_after_restart()
    assert loose.ledger.get_meta(family_add.LOOSENED) is None


def test_the_built_app_ties_authority_to_the_real_policy_model_and_credentials(tmp_path, monkeypatch):
    from harness import __main__ as main, policy
    monkeypatch.setattr(main, "serve", lambda *a, **k: None)
    monkeypatch.setattr(main.family, "serve", lambda *a, **k: None)
    controller, _, _ = main.build(str(tmp_path))
    try:
        fa = controller.family_add
        assert fa.policy_version == controller.base_config.policy_version
        assert fa.model == policy.MODELS[policy.engine_for("message")].model
        before = fa.creds_stamp()
        controller.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
        assert fa.creds_stamp() != before
        assert APP_PASSWORD not in fa.creds_stamp()
    finally:
        controller.executor.shutdown(wait=False)
        controller.ledger.db.close()


# -- review round: the digest and /status say so ----------------------------------------------------

class WindowsSafeSince:
    """The digest's date line uses a strftime code Windows lacks."""
    def astimezone(self, tz):
        return self

    def strftime(self, fmt):
        return "Oct 20"


def test_status_says_adds_skip_the_tap(loose):
    assert "skipping the Approve tap" in loose.fa.status_line()
    assert "/checkadds" in loose.fa.status_line()


def test_the_digest_line_appears_only_while_adds_skip_the_tap(on):
    assert on.fa.digest_line() == ""
    count_up(on, 10, 14)
    assert on.fa.digest_line() == ""
    on.press(ask_cards(on)[-1], STOP)
    assert "skip the Approve tap" in on.fa.digest_line()


def test_the_digest_line_counts_since_the_last_digest(loose):
    loose.ledger.set_meta("last_digest_at", iso(loose.clock()))
    loose.ask(**fresh())
    loose.ask(**fresh())
    assert ": 2 added since the last digest" in loose.fa.digest_line()


def test_a_clear_digest_carries_the_line(loose):
    from harness import digest
    d = digest.compose(now=loose.clock(), tz="America/New_York", inputs=[], waiting=[],
                       failures=[], low_balance=[], canary_ok=True,
                       config_unchanged_since=WindowsSafeSince(), extra=[loose.fa.digest_line()])
    assert d.state == "clear" and "skip the Approve tap" in d.text


def test_the_controller_puts_the_line_in_the_real_digest(loose):
    loose.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    loose.ledger.set_meta("digest_date", "2000-01-01")
    loose.c._daily(False)
    loose.c.outbox.flush()
    assert "skip the Approve tap" in loose.texts()[-1]


def test_gather_passes_the_line(loose):
    loose.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    d = daily.gather(loose.ledger, Config(owner_user_id=OWNER, stage="S1"), paused=False,
                     family_add_line=loose.fa.digest_line())
    assert "skip the Approve tap" in d.text


# -- third round: a tapless add is checked again just before its write -------------------------

def batch(rig, *params_list):
    rig.claude.script = [proposal(**p) for p in params_list]
    items = []
    for i, _ in enumerate(params_list):
        rig.uid += 1
        items.append(msg(rig.uid, f"add thing {i}"))
    rig.bot.batches.append(items)
    rig.tick()


def titles(rig):
    return [props(v[1])["SUMMARY"][0].split(":", 1)[1] for v in rig.icloud.family().values()]


def test_two_tapless_adds_in_one_tick_second_is_refused_after_the_tap_returns(loose):
    a, b = {**fresh(), "title": "First one"}, {**fresh(), "title": "Second one"}
    loose.icloud.drop_response_next = True
    batch(loose, a, b)
    assert not loose.fa.loosened()
    assert loose.icloud.methods().count("PUT") == 1 and "Second one" not in titles(loose)
    said = "\n".join(loose.texts())
    assert "The Approve tap came back before I wrote this" in said and "Second one" in said
    assert loose.jobs("failed")[-1]["id"]
    reasons = [loose.receipt(j["id"])["reason"] for j in loose.jobs("failed")]
    assert "tap_restored" in reasons


def test_two_clean_tapless_adds_in_one_tick_both_write(loose):
    batch(loose, fresh(), fresh())
    assert loose.icloud.methods().count("PUT") == 2 and loose.fa.loosened()


def test_an_aborted_tick_then_checkadds_never_writes_the_queued_add(loose, monkeypatch):
    orig = loose.c.runner.check_timers

    def boom():
        monkeypatch.setattr(loose.c.runner, "check_timers", orig)
        raise ValueError("a bug later in the tick")
    monkeypatch.setattr(loose.c.runner, "check_timers", boom)
    with pytest.raises(ValueError):
        loose.ask(**{**fresh(), "title": "Stale one"})
    assert loose.icloud.methods().count("PUT") == 0
    loose.say("/checkadds")
    assert not loose.fa.loosened() and loose.icloud.methods().count("PUT") == 0
    assert "Stale one" not in titles(loose)
    assert any("Approve tap came back" in t and "Stale one" in t for t in loose.texts())


def test_a_tapped_add_is_not_stopped_by_that_check(on):
    on.ask(**fresh())
    on.press(on.last(), "Approve")
    assert on.icloud.methods().count("PUT") == 1


def test_a_restart_refuses_a_queued_tapless_add(loose, monkeypatch):
    orig = loose.c.runner.check_timers

    def boom():
        monkeypatch.setattr(loose.c.runner, "check_timers", orig)
        raise ValueError("x")
    monkeypatch.setattr(loose.c.runner, "check_timers", boom)
    with pytest.raises(ValueError):
        loose.ask(**fresh())
    loose.start()
    assert loose.icloud.methods().count("PUT") == 0


# -- third round: the count is held for the policy and model it was earned on -------------------

@pytest.mark.parametrize("attr", ["model", "policy_version"])
def test_a_change_during_the_count_restarts_it_and_no_card_comes(on, attr):
    for _ in range(10):
        on.add_one(**fresh())
    old = on.fa._bake()["epoch"]
    setattr(on.fa, attr, "changed")
    on.advance(days=15)
    on.tick()
    assert on.fa._bake()["n"] == 0 and on.fa._bake()["epoch"] != old
    assert ask_cards(on) == []


@pytest.mark.parametrize("attr", ["model", "policy_version"])
def test_an_open_card_is_void_after_a_change(on, attr):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    setattr(on.fa, attr, "changed")
    on.tick()
    on.press(card, STOP)
    assert not on.fa.loosened() and "record changed" in on.texts()[-1]


@pytest.mark.parametrize("attr", ["model", "policy_version"])
def test_a_change_in_the_same_batch_as_the_tap_is_void_too(on, attr):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    setattr(on.fa, attr, "changed")
    on.press(card, STOP)
    assert not on.fa.loosened() and "record changed" in on.texts()[-1]
    assert not any("no longer wait for your tap" in t for t in on.texts())


def test_a_damaged_loosened_setting_brings_the_tap_back(loose):
    loose.ledger.set_meta(family_add.LOOSENED, "{}")
    loose.tick()
    assert loose.ledger.get_meta(family_add.LOOSENED) is None
    assert any("Approve tap again" in t for t in loose.texts())


def test_a_full_count_on_the_new_model_can_ask_again(on):
    count_up(on, 10, 0)
    on.fa.model = "changed"
    on.tick()
    count_up(on, 10, 14)
    assert len(ask_cards(on)) == 1
    on.press(ask_cards(on)[0], STOP)
    assert on.fa.loosened()


# -- third round: the record must be true when he taps ------------------------------------------

def test_a_tap_on_a_stale_record_loosens_nothing_and_sends_a_fresh_card(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    for _ in range(5):
        on.ask(**fresh())
        on.press(on.last(), "Decline")
    for path in list(on.icloud.family())[:6]:
        del on.icloud.events[path]
    on.advance(days=2)
    on.press(card, STOP)
    assert not on.fa.loosened()
    assert "record changed since that card" in on.texts()[-1]
    fresh_card = ask_cards(on)[-1]
    assert fresh_card != card
    assert "5 declined" in fresh_card[1] and "6 of those 10" in fresh_card[1]
    on.press(fresh_card, STOP)
    assert on.fa.loosened()


def test_hand_deletes_alone_void_the_card(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    del on.icloud.events[next(iter(on.icloud.family()))]
    on.press(card, STOP)
    assert not on.fa.loosened() and "1 of those 10" in ask_cards(on)[-1][1]


def test_one_more_add_voids_the_card(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.add_one(**fresh())
    on.press(card, STOP)
    assert not on.fa.loosened() and "11 approved" in ask_cards(on)[-1][1]


def test_a_tap_when_the_check_cant_complete_loosens_nothing_and_says_why(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.icloud.down = True
    on.press(card, STOP)
    assert not on.fa.loosened() and "couldn't check the calendar" in on.texts()[-1]
    assert len(ask_cards(on)) == 1
    on.icloud.down = False
    on.advance(hours=2)
    on.tick()
    assert len(ask_cards(on)) == 2
    on.press(ask_cards(on)[-1], STOP)
    assert on.fa.loosened()


def test_the_tap_reads_the_calendar(on):
    count_up(on, 10, 14)
    on.icloud.log.clear()
    on.press(ask_cards(on)[0], STOP)
    assert on.icloud.methods().count("GET") == 10 and "PUT" not in on.icloud.methods()


def test_the_card_lives_three_days(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.advance(days=2, hours=23)
    on.tick()
    on.press(card, STOP)
    assert on.fa.loosened()


def test_after_three_days_the_card_is_dead(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.advance(days=3, minutes=1)
    on.press(card, STOP)
    assert not on.fa.loosened()


def test_an_ignored_card_asks_again_at_most_once_a_week(on):
    count_up(on, 10, 14)
    assert len(ask_cards(on)) == 1
    on.advance(days=6, hours=23)
    on.tick()
    assert len(ask_cards(on)) == 1
    on.advance(hours=2)
    on.tick()
    assert len(ask_cards(on)) == 2
    on.tick()
    on.advance(days=1)
    on.tick()
    assert len(ask_cards(on)) == 2


# -- third round: the record ----------------------------------------------------------------------

def do_reset(rig):
    rig.requests.put({"type": "reset", "by": "Owner"})
    rig.tick()
    rig.vault.set_key("family_apple_id", APPLE_ID, by="Owner")
    rig.vault.set_key("family_app_password", APP_PASSWORD, by="Owner")
    rig.vault.set_key("family_calendar_url", FAMILY_URL, by="Owner")
    own(rig.vault, OWNER)
    rig.tick()


def test_the_record_does_not_reach_across_a_reset(on):
    for _ in range(12):
        on.add_one(**fresh())
    for _ in range(4):
        on.ask(**fresh())
        on.press(on.last(), "Decline")
    do_reset(on)
    on.turn_on()
    on.bot.sent.clear()
    on.icloud.log.clear()
    count_up(on, 10, 14)
    text = ask_cards(on)[0][1]
    assert "10 approved and added, 0 declined" in text and "Before this count" not in text
    assert "0 of those 10" in text
    assert on.icloud.methods().count("GET") == 10


def test_a_later_restart_does_not_bring_back_what_a_reset_forgot(on):
    for _ in range(4):
        on.ask(**fresh())
        on.press(on.last(), "Decline")
    do_reset(on)
    on.turn_on()
    receipt = on.add_one(**fresh())
    on.press(receipt, "Undo")
    count_up(on, 10, 14)
    text = ask_cards(on)[0][1]
    assert "Before this count: 0 declined" in text and "1 undone" in text


def test_a_refusal_at_execution_is_on_the_record(on):
    on.ask(start="2026-10-21T10:00:00-04:00", end="2026-10-21T11:00:00-04:00")
    on.advance(hours=2)
    on.press(on.with_button("Approve"), "Approve")
    count_up(on, 10, 14)
    assert "1 refused" in ask_cards(on)[0][1]


def test_refusals_and_warnings_before_a_restart_are_in_the_earlier_line(on):
    on.ask(start="2026-11-10T09:00:00-05:00", end="2026-11-12T09:00:00-05:00")
    receipt = on.add_one(start="2027-02-02T10:00:00-04:00", end="2027-02-02T11:00:00-04:00")
    on.press(receipt, "Undo")
    count_up(on, 10, 14)
    now, earlier = ask_cards(on)[0][1].split("Before this count:")
    assert "0 refused" in now and "0 shown with a warning" in now
    assert "1 refused" in earlier and "1 shown with a warning" in earlier


def test_a_new_address_after_a_reset_cannot_say_more_missing_than_added(on):
    from fake_caldav import OTHER_PATH
    for _ in range(12):
        on.add_one(**fresh())
    do_reset(on)
    on.icloud.names[OTHER_PATH] = "Family"
    on.vault.set_key("family_calendar_url", OTHER_URL, by="Owner")
    on.tick()
    on.turn_on()
    on.bot.sent.clear()
    count_up(on, 10, 14)
    assert "0 of those 10" in ask_cards(on)[0][1]


def test_the_missing_check_stays_inside_the_count(on):
    receipt = on.add_one(**fresh())
    for _ in range(2):
        on.add_one(**fresh())
    on.press(receipt, "Undo")
    on.icloud.log.clear()
    count_up(on, 10, 14)
    assert on.icloud.methods().count("GET") == 10


def test_the_record_counts_cancelled_refused_and_warned(on):
    for _ in range(3):
        on.ask(**fresh())
        on.say("/cancel")
    for _ in range(2):
        on.ask(start="2026-11-10T09:00:00-05:00", end="2026-11-12T09:00:00-05:00")
    on.ask(**{**fresh(), "title": "\u200bhidden"})         # refused by shape, in words
    for _ in range(10):
        e = fresh()
        e["start"], e["end"] = e["start"].replace("-05:00", "-04:00"), e["end"].replace("-05:00", "-04:00")
        on.add_one(**e)
    on.advance(days=15)
    on.tick()
    text = ask_cards(on)[0][1]
    assert "3 cancelled" in text and "3 refused" in text
    assert "10 shown with a warning" in text


def test_a_warned_count_is_in_what_a_tap_compares(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.ask(**{**fresh(), "start": "2027-02-02T10:00:00-04:00", "end": "2027-02-02T11:00:00-04:00"})
    on.press(card, STOP)
    assert not on.fa.loosened() and "1 shown with a warning" in ask_cards(on)[-1][1]


# -- third round: reset ends open Approve cards -----------------------------------------------------

def test_an_old_approve_card_does_nothing_after_a_reset(on):
    on.ask(**{**fresh(), "title": "Before reset"})
    old = on.with_button("Approve")
    do_reset(on)
    on.turn_on()
    on.press(old, "Approve")
    assert "PUT" not in on.icloud.methods() and "Before reset" not in titles(on)
    row = on.ledger.db.execute("SELECT state FROM proposals").fetchall()
    assert [r["state"] for r in row] == ["cancelled"]
    assert on.ledger.db.execute("SELECT outcome FROM approvals").fetchone()[0] == "reset"


def test_a_reset_gives_an_open_job_a_receipt(on):
    on.ask()
    on.fa.forget()
    [job] = on.jobs("cancelled")
    assert on.receipt(job["id"])["reason"] == "reset"


def test_a_reset_leaves_other_effects_approvals_alone(on, ledger):
    on.ask()
    with ledger.tx() as db:
        db.execute("UPDATE proposals SET effect_type='calendar_hold'")
    on.fa.forget()
    assert ledger.db.execute("SELECT consumed_at FROM approvals").fetchone()[0] is None


# -- third round: ordinary titles -------------------------------------------------------------------

ORDINARY = ["Dr.Smith", "J.Smith dentist", "St.Mary's", "Mt.Sinai", "Mr.Jones", "Main St.Suite 4",
            "Jr.High play", "appt.tomorrow", "soccer.Practice", "Dentist", "Dr. Smith",
            "Bob & Sue's", "Kid's B-day!", "100% attendance", "Soccer @ field", "Mom/Dad night",
            "Lunch w/Bob", "O’Brien", "Café", "PTA #5", "P.E. day", "3:30 pickup",
            "10 a.m. call", "Parents' night 6.30pm", "\u2615 coffee", "\u260e\ufe0f call",
            "1\ufe0f\u20e3 first", "\U0001F382 party", "\U0001F1FA\U0001F1F8 parade", "Room 3.14",
            "U.S. Open", "Hi\u00a0there", "Dad /Mom", "/kids dinner", "@Home party",
            "\U0001F468\u200d\U0001F469\u200d\U0001F467 dinner",
            "\U0001F3F3\ufe0f\u200d\U0001F308 parade",
            "\U0001F9D1\U0001F3FB\u200d\U0001F393 grad",
            "\u0645\u06cc\u200c\u0631\u0648\u0645"]


@pytest.mark.parametrize("title", ORDINARY)
def test_ordinary_titles_pass_and_the_receipt_shows_them_exactly(on, title):
    on.ask(title=title)
    on.press(on.with_button("Approve"), "Approve")
    written = next(iter(on.icloud.family().values()))[1]
    assert title.replace(",", "\\,") in written.replace("\r\n ", "")
    shown = render.plain(on.with_button("Undo")[1]).replace(render.WORD_JOINER, "")
    assert title in shown


@pytest.mark.parametrize("text", [
    "see evil.com", "EVIL.COM", "pay at evil.io now", "sub.evil.co.uk", "https://x.example",
    "HTTP://Example", "ftp://files", "tg://resolve", "10.0.0.1", "mom.dad/kids", "evil.zip",
])
def test_links_are_still_refused_in_plain_words(on, text):
    on.ask(title=text)
    _, said, buttons, _ = on.last()
    assert "link or web address" in said and "I didn't add that" in said and buttons is None


@pytest.mark.parametrize("text", ["Dr.Smith", "@Home", "/kids"])
def test_the_card_shows_these_exactly_too(on, text):
    on.ask(title=text)
    shown = render.plain(on.last()[1]).replace(render.WORD_JOINER, "")
    assert text in shown and "[.]" not in shown


def test_commands_and_mentions_stay_inert_on_the_card(on):
    on.ask(title="/stop @someone")
    text = on.last()[1]
    assert "/stop" not in text and "@someone" not in text


def test_model_text_elsewhere_is_still_defanged():
    assert "Dr[.]Smith" in render.model_text("Dr.Smith")


@pytest.mark.parametrize("title", [
    "Den\u200dtist", "\u200dDentist", "Dentist\u200d", "\U0001F468\u200d", "a\u200db",
    "\U0001F468\u200da", "a\u200d\U0001F468", "a\u200cb", "a\u200c\u0645", "\u0645\u200c", "\u200c\u0645", "\u0645\u200ca",
    "co\u00adoperate",
])
def test_joiners_anywhere_but_their_real_places_are_refused(title):
    with pytest.raises(schema.OutputError, match="invisible or special"):
        parse({**EVENT, "title": title})


@pytest.mark.parametrize("title, words", [
    ("co\u00adoperate", "invisible or special character"),
    ("\u200b", "invisible or special character"),
    ("   ", "the title is blank"),
])
def test_a_refused_character_is_said_plainly_with_a_receipt(on, title, words):
    on.ask(title=title)
    _, said, buttons, _ = on.last()
    assert words in said and "I didn't add that" in said and buttons is None
    assert "shapes" not in said
    assert on.receipt(on.jobs("no_action")[-1]["id"])["reason"] == "family_add_impossible"
    assert on.icloud.log == []


# -- third round: invisible and unassigned characters ---------------------------------------------

def test_a_null_notehead_is_refused_as_drawn_as_nothing():
    with pytest.raises(schema.OutputError, match="invisible or special"):
        parse({**EVENT, "title": "\U0001D159"})


@pytest.mark.parametrize("title", ["\ufe0f", "\U000E0100", "\ufe00", "\u180b", 
                                   "...", "- -", "\ufe0f\ufe0f"])
def test_a_title_needs_a_visible_letter_digit_or_symbol(title):
    with pytest.raises(schema.OutputError, match="blank"):
        parse({**EVENT, "title": title})


def test_a_location_of_only_invisible_marks_is_refused():
    with pytest.raises(schema.OutputError, match="location is blank"):
        parse({**EVENT, "location": "\ufe0f"})


def test_no_location_is_still_fine():
    assert parse({**EVENT, "location": ""}) and parse({**EVENT, "location": "  "})


@pytest.mark.parametrize("c", ["\ufffc", "\ue000", "\U000F0000", "\u0378"])
def test_placeholder_private_use_and_unassigned_are_refused(c):
    with pytest.raises(schema.OutputError, match="invisible or special"):
        parse({**EVENT, "title": "A" + c})


# -- third round: same start while loosened ------------------------------------------------------

@pytest.mark.parametrize("a, b", [
    ("Dentist appt", "Dentist  appt"), ("Café night", "Cafe\u0301 night"),
    ("Dentist", "Dentist."), ("Dentist", "Dentist appointment"), ("Dentist", "Dentist\ufe0f"),
    ("Dentist", "Dentіst"), ("Dentist", "Something else"),
])
def test_loose_any_earlier_add_at_the_same_start_gets_a_card(loose, a, b):
    p = {**fresh(), "title": a}
    loose.ask(**p)
    loose.ask(**{**p, "title": b})
    assert loose.icloud.methods().count("PUT") == 1
    assert "another add has the same start" in loose.last()[1]


def test_loose_the_same_instant_in_another_offset_gets_a_card(loose):
    from datetime import datetime, timezone
    p = fresh()
    loose.ask(**p)
    other = datetime.fromisoformat(p["start"]).astimezone(timezone.utc).isoformat()
    assert loose.fa._is_duplicate({"title": "x", "start": other}, any_title=True)


def test_loose_an_undone_add_does_not_block_its_start_when_earned_again(on):
    count_up(on, 10, 14)
    on.press(ask_cards(on)[-1], STOP)
    p = fresh()
    on.ask(**p)
    on.say("/checkadds")
    assert on.fa._is_duplicate(p, any_title=True)
    on.press(on.with_button("Undo"), "Undo")
    assert not on.fa._is_duplicate(p, any_title=True)


def test_the_tap_stage_still_only_warns_on_the_same_title(on):
    p = fresh()
    on.add_one(**p)
    on.ask(**{**p, "title": "Other"})
    assert "duplicate" not in on.last()[1]


# -- third round: pasted or long messages while loosened -------------------------------------------

def say_with(rig, text, **params):
    rig.claude.script = [proposal(**params)]
    rig.say(text)


# Nov 11: he dictates, often at length and over several lines. Only real signs of text from
# elsewhere count: a quoted line, an email's header lines, a forward, a link.
PASTED_EMAIL = ("From: Gala Committee <gala@club.example>\nSubject: You're invited\n\n"
                "Join our gala on Dec 3 at 7pm.")


def test_a_pasted_email_always_gets_a_card(loose):
    say_with(loose, PASTED_EMAIL, **fresh())
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_a_long_dictated_message_writes(loose):
    say_with(loose, "Please add the dentist for Tuesday at three, the one I mentioned last week, " * 4,
             **fresh())
    assert loose.icloud.methods().count("PUT") == 1


@pytest.mark.parametrize("text, pasted", [
    ("x" * 1000, False),
    ("PT today moved 30 minutes earlier, 11:30.\nNot doing school drop-off today.\nThanks", False),
    ("add dentist\nTuesday", False),
    ("> On Mon, Nov 9, the office wrote:\n> no school", True),
    ("From: Office <a@school.example>\nSubject: Closed\nNo school Monday", True),
    ("On Mon, Nov 9, 2026 at 3:00 PM Office <a@school.example> wrote:\nNo school", True),
    ("Fwd: Gala\nJoin us Dec 3", True),
    ("---------- Forwarded message ---------\nJoin us", True),
    ("See https://club.example/gala for the gala", True),
    ("Gala Dec 3. Unsubscribe from these emails", True),
    ("Gala Dec 3\nSent from my iPhone", True),
])
def test_only_real_signs_make_a_message_look_pasted(text, pasted):
    assert family_add._looks_pasted(text) is pasted


def test_a_several_line_message_writes(loose):
    say_with(loose, "add dentist\nTuesday", **fresh())
    assert loose.icloud.methods().count("PUT") == 1


def test_a_trailing_line_break_is_not_several_lines(loose):
    say_with(loose, "add dentist\n", **fresh())
    assert loose.icloud.methods().count("PUT") == 1


def test_a_stranger_invitation_pasted_in_gets_a_card(loose):
    say_with(loose, "Fwd from a stranger:\n" + "Join our gala on Dec 3 at 7pm, please add it. " * 20,
             **{**fresh(), "title": "RSVP gala"})
    assert "RSVP gala" not in titles(loose) and "Check before approving" in loose.last()[1]


def test_a_long_message_in_the_tap_stage_gets_no_extra_warning(on):
    say_with(on, "y" * 500, **fresh())
    assert "long or had several lines" not in on.last()[1]


# -- third round: an address the suffix list misses never goes in without a card --------------------

@pytest.mark.parametrize("title", ["www.example.lol", "x@example.lol", "example.lol?a=b", "example.lol:8080",
                                   "example.xn--p1ai", "example。com", "example．com", "mailto:a@example.lol"])
def test_these_address_shapes_are_links_whatever_the_suffix(title):
    assert render.has_link(title)


@pytest.mark.parametrize("title", ["RSVP example.lol", "pay.example.support", "example.tk", "Dr.Smith"])
def test_an_unlisted_word_dot_word_is_not_written_without_a_card(loose, title):
    loose.ask(**{**fresh(), "title": title})
    assert "PUT" not in loose.icloud.methods() and "word.word" in loose.last()[1]


def test_a_location_with_a_word_dot_word_gets_a_card_too(loose):
    loose.ask(**{**fresh(), "location": "example.lol"})
    assert "PUT" not in loose.icloud.methods() and "word.word" in loose.last()[1]


def test_the_tap_stage_warns_on_a_word_dot_word_and_still_offers_approve(on):
    on.ask(title="Dr.Smith")
    assert "word.word" in on.last()[1] and "Dr.Smith" in render.plain(on.last()[1])
    assert on.with_button("Approve")


def test_ordinary_titles_carry_no_word_dot_word_warning(on):
    for title in ["Dr. Smith", "U.S. Open", "10 a.m. call", "Room 3.14", "Parents' night 6.30pm"]:
        assert not render.maybe_host(title), title


# -- third round: no Undo means no tapless add ----------------------------------------------------

def test_a_tapless_add_with_no_undo_restores_the_tap_and_says_so(loose, monkeypatch):
    loose.icloud.put_returns_etag = False
    monkeypatch.setattr(loose.fa.client, "_read_etag", lambda *a: None)
    loose.ask(**fresh())
    assert loose.icloud.methods().count("PUT") == 1
    assert not loose.fa.loosened() and loose.fa._bake()["n"] == 0
    assert any("no Undo available" in t and "Approve tap again" in t for t in loose.texts())
    assert any("can't offer Undo" in t for t in loose.texts())


def test_a_tapped_add_with_no_undo_does_not_restart_the_count(on, monkeypatch):
    on.icloud.put_returns_etag = False
    monkeypatch.setattr(on.fa.client, "_read_etag", lambda *a: None)
    on.ask(**fresh())
    on.press(on.last(), "Approve")
    assert on.fa._bake()["n"] == 1
