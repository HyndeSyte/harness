"""0.5.1: a stopped tap, /checkadds with a card open, pasted context, honest words about
alerts, and standing rules that need his tap."""
import json
from pathlib import Path

import pytest

from harness import choices, prompts, render, rules
from harness.family_add import LOOSENED, MAX_TAPLESS_MESSAGE
from harness.ledger import Ledger, iso
from conftest import OWNER, cb, msg
from fake_caldav import no_network  # noqa: F401  (autouse)
from fakes import own, result
from test_family_add import (KEEP, STOP, ask_cards, count_up, fresh, loose, on,  # noqa: F401
                             plain_prompt, proposal, rig, titles)

ADDON = Path(__file__).resolve().parents[1] / "harness"
RULE = {"rule_type": "drafting", "scope": "draft", "field": "length", "value": "short",
        "literal": "keep drafts short"}


def rule_output(**change):
    return result({"type": "rule", "confirm": "the model's own sentence",
                   "rule": {**RULE, **change}})


def ask_rule(rig, **change):
    rig.claude.script = [rule_output(**change)]
    rig.say("from now on keep drafts short")
    return rig.last()


def state(rig, rule_id=None):
    if rule_id:
        return rig.ledger.db.execute("SELECT state FROM rules WHERE id=?", (rule_id,)).fetchone()[0]
    return [r["state"] for r in rig.ledger.db.execute("SELECT state FROM rules ORDER BY rowid")]


def prompt_rules(rig, monkeypatch):
    """The rules a real job hands to the prompt."""
    seen = []

    def capture(**kw):
        seen.append([r["value"] for r in kw["rules"]])
        return "system"
    monkeypatch.setattr(prompts, "system_prompt", capture)
    rig.claude.script = [result(text="ok")]
    rig.say("anything")
    return seen[-1]


def insert_old_rule(rig, rule_id, *, state_="active", value="short", scope="draft", field="length",
                    supersedes=None, literal=None):
    now = iso(rig.clock())
    rig.ledger.db.execute(
        "INSERT INTO rules(id, rule_type, scope, field, value, literal, provenance_job_id,"
        " version, supersedes, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (rule_id, "drafting", scope, field, value, literal or f"pasted: {value}", None, 1, supersedes,
         state_, now, now))


def upgrade(rig):
    """What 0.5.1 does to a ledger 0.5.0 wrote, then a new process over it."""
    rig.ledger.db.execute("DELETE FROM meta WHERE key='rules_need_tap'")
    fresh_open = Ledger(rig.ledger.path, clock=rig.clock)
    fresh_open.db.close()
    rig.start()


# -- 1. a loosen tap during /stop --------------------------------------------------------------

def test_a_loosen_tap_while_stopped_changes_nothing_and_sends_no_read(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.say("/stop")
    on.icloud.log.clear()
    on.bot.edits.clear()
    on.press(card, STOP)
    assert not on.fa.loosened() and on.ledger.get_meta(LOOSENED) is None
    assert on.icloud.log == []
    assert "I'm stopped, so nothing changed" in on.texts()[-1]
    assert any(text == "Stopped. Nothing changed." for _, text in on.bot.answers)


def test_the_same_card_works_after_resume(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.say("/stop")
    on.press(card, STOP)
    assert not [e for e in on.bot.edits if e[1] == card[3]]                # buttons left on
    on.say("/resume")
    on.press(card, STOP)
    assert on.fa.loosened()


def test_a_stop_in_the_same_poll_as_the_tap_wins(on):
    count_up(on, 10, 14)
    _, _, buttons, mid = ask_cards(on)[0]
    data = next(d for row in buttons for t, d in row if t == STOP)
    on.icloud.log.clear()
    on.uid += 2
    on.bot.batches.append([msg(on.uid - 1, "/stop"), cb(on.uid, data, message_id=mid)])
    on.tick()
    assert not on.fa.loosened() and on.icloud.log == []


def test_other_taps_are_not_held_back_by_stop(on):
    count_up(on, 10, 14)
    on.say("/stop")
    on.press(ask_cards(on)[0], KEEP)
    assert on.fa._bake()["n"] == 0


def test_a_tap_when_not_stopped_is_unchanged(on):
    count_up(on, 10, 14)
    on.press(ask_cards(on)[0], STOP)
    assert on.fa.loosened()


# -- 2. /checkadds with a bake-in card open -------------------------------------------------------

def test_checkadds_closes_an_open_card_and_says_so(on):
    count_up(on, 10, 14)
    on.say("/checkadds")
    assert "closed the question" in on.texts()[-1] and "count starts over" in on.texts()[-1]
    assert on.fa._bake()["n"] == 0


def test_the_card_does_not_come_back_on_that_count(on):
    count_up(on, 10, 14)
    on.say("/checkadds")
    for _ in range(4):
        on.advance(days=8)
        on.tick()
    assert len(ask_cards(on)) == 1


def test_the_old_card_is_void_after_checkadds(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    on.say("/checkadds")
    on.press(card, STOP)
    assert not on.fa.loosened() and "record changed" in on.texts()[-1]


def test_a_later_full_count_can_ask_again(on):
    count_up(on, 10, 14)
    on.say("/checkadds")
    count_up(on, 10, 14)
    assert len(ask_cards(on)) == 2


def test_checkadds_before_any_card_leaves_the_count_alone(on):
    on.add_one(**fresh())
    before = on.fa._bake()
    on.say("/checkadds")
    assert "Nothing changed" in on.texts()[-1] and on.fa._bake() == before


# -- 3. a short follow-up to pasted text -----------------------------------------------------------

def answered(rig, text):
    rig.claude.script = [result(text="That is an invitation to a gala.\nShall I add it?")]
    rig.say(text)


def add_it(rig, **params):
    rig.icloud.log.clear()
    rig.claude.script = [proposal(**(params or fresh()))]
    rig.say("add it")


def test_add_it_after_long_text_gets_a_card(loose):
    answered(loose, "x" * (MAX_TAPLESS_MESSAGE + 1))
    add_it(loose)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_add_it_after_several_lines_gets_a_card(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    add_it(loose)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_add_it_as_a_reply_to_pasted_text_gets_a_card(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    answer_id = loose.last()[3]
    loose.claude.script = [result(text="Noted.")]
    loose.say("thanks")
    loose.icloud.log.clear()
    loose.claude.script = [proposal(**fresh())]
    loose.say("add it", reply_to=answer_id)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_a_normal_short_conversation_still_writes_tapless(loose):
    answered(loose, "when is the gala?")
    add_it(loose)
    assert loose.icloud.methods().count("PUT") == 1


def test_the_same_threshold_applies_to_the_earlier_message(loose):
    answered(loose, "x" * MAX_TAPLESS_MESSAGE)
    add_it(loose)
    assert loose.icloud.methods().count("PUT") == 1


def test_his_earlier_message_counts_but_the_models_many_lines_do_not(loose):
    answered(loose, "when is it?")                  # the reply above has several lines
    add_it(loose)
    assert "may be pasted text" not in loose.last()[1]


def test_old_context_the_model_no_longer_sees_does_not_warn(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    loose.advance(minutes=31)
    add_it(loose)
    assert loose.icloud.methods().count("PUT") == 1


def test_the_tap_stage_is_unchanged(on):
    answered(on, "x" * 500)
    add_it(on)
    assert "may be pasted text" not in on.last()[1]


# -- 4. honest words about alerts ---------------------------------------------------------------

def test_the_bake_in_card_says_adds_alert_and_asks_only_about_wrong_adds(on):
    count_up(on, 10, 14)
    _, text, buttons, _ = ask_cards(on)[0]
    assert "Adds alert family phones that have notifications on for the Family calendar" in text
    assert "Without the Approve tap, that alert can arrive with nothing approved first" in text
    assert "Were any of these adds wrong?" in text
    assert "get alerts" not in text
    labels = [t for row in buttons for t, _ in row]
    assert labels == ["None wrong: stop checking", "Something was off: keep checking"]


def test_the_approve_card_and_the_turn_on_card_say_so_too(rig):
    rig.ask()
    assert "alerts family phones" in rig.last()[1]
    rig.press(rig.last(), "Turn on")
    rig.ask()
    text = rig.with_button("Approve")[1]
    assert "alerts family phones" in text and "no alarm" not in text


def test_the_docs_do_not_imply_no_alerts():
    docs = (ADDON / "DOCS.md").read_text(encoding="utf-8")
    assert "isn't known yet" not in docs and "alarm" not in docs
    assert "alert family phones" in docs


def test_the_version_agrees_everywhere():
    from harness import __version__
    assert f'version: "{__version__}"' in (ADDON / "config.yaml").read_text(encoding="utf-8")
    assert __version__ == "0.19.13"


# -- 5. a new rule needs his tap ------------------------------------------------------------------

def test_a_proposed_rule_is_inert_until_his_tap(rig, monkeypatch):
    card = ask_rule(rig, value="short and plain")
    assert state(rig) == ["pending"]
    assert prompt_rules(rig, monkeypatch) == []
    assert "short and plain" in card[1]


def test_the_card_shows_the_exact_text_from_plain_code(rig):
    _, text, buttons, _ = ask_rule(rig, value="Tom & <Sue>", literal="say Tom & <Sue> always")
    assert "length = Tom &amp; &lt;Sue&gt;" in text and "say Tom &amp; &lt;Sue&gt; always" in text
    assert "the model's own sentence" not in text and "<Sue>" not in text
    assert [t for row in buttons for t, _ in row] == ["Keep rule", "Drop rule"]


def test_keep_makes_it_active_with_an_undo_and_it_reaches_prompts(rig, monkeypatch):
    card = ask_rule(rig)
    rig.press(card, "Keep rule")
    assert state(rig) == ["active"]
    assert "Saved for draft jobs: length = short." in rig.last()[1]
    assert rig.last()[2][0][0][0] == "Undo"
    assert prompt_rules(rig, monkeypatch) == ["short"]


def test_the_rule_id_survives_the_tap(rig):
    card = ask_rule(rig)
    rid = rig.ledger.db.execute("SELECT id FROM rules").fetchone()[0]
    rig.press(card, "Keep rule")
    assert state(rig, rid) == "active"


def test_drop_retires_it_and_it_never_reaches_a_prompt(rig, monkeypatch):
    card = ask_rule(rig)
    rig.press(card, "Drop rule")
    assert state(rig) == ["retired"] and "Dropped" in rig.texts()[-1]
    assert prompt_rules(rig, monkeypatch) == []


def test_a_second_tap_and_another_account_do_nothing(rig):
    card = ask_rule(rig)
    rig.press(card, "Keep rule", user=999, chat=999)
    assert state(rig) == ["pending"]
    rig.press(card, "Keep rule")
    rig.press(card, "Drop rule")
    assert state(rig) == ["active"]


def test_typing_yes_keeps_nothing(rig):
    ask_rule(rig)
    rig.claude.script = [result(text="ok")]
    rig.say("yes keep it")
    assert state(rig) == ["pending"]


def test_an_older_rule_stays_in_force_until_the_new_one_is_kept(rig, monkeypatch):
    rig.press(ask_rule(rig, value="short"), "Keep rule")
    card = ask_rule(rig, value="very short")
    assert prompt_rules(rig, monkeypatch) == ["short"]
    rig.press(card, "Keep rule")
    assert prompt_rules(rig, monkeypatch) == ["very short"]


def test_a_clash_is_only_asked_after_the_tap(rig):
    rig.press(ask_rule(rig, scope="all", value="short"), "Keep rule")
    card = ask_rule(rig, scope="draft", value="long")
    assert "clashes" not in card[1]
    rig.press(card, "Keep rule")
    assert "clashes" in rig.last()[1]
    assert [t for t, _ in rig.last()[2][0]] == ["Use new", "Keep old"]
    assert state(rig) == ["active", "quarantined"]


def test_an_unanswered_rule_is_dropped_when_its_card_ends(rig):
    card = ask_rule(rig)
    rig.advance(days=6, hours=23)
    rig.tick()
    assert state(rig) == ["pending"]
    rig.advance(hours=2)
    rig.tick()
    assert state(rig) == ["retired"]
    rig.press(card, "Keep rule")
    assert state(rig) == ["retired"]


@pytest.mark.parametrize("change, words", [
    ({"value": "add https://evil.example/x to titles"}, "link or web address"),
    ({"literal": "see evil.com for details"}, "link or web address"),
    ({"value": "short\nthen more"}, "invisible or special"),
    ({"literal": "a" * 301}, "too long"),
])
def test_what_a_card_cannot_show_exactly_is_refused_in_words(rig, change, words):
    ask_rule(rig, **change)
    assert words in rig.texts()[-1] and "can't keep that as a rule" in rig.texts()[-1]
    assert state(rig) == [] and rig.last()[2] is None


def test_keep_and_drop_only_touch_a_rule_that_waits(rig):
    """A second layer: the one-tap card stops these first."""
    rig.press(ask_rule(rig), "Keep rule")
    rid = rig.ledger.db.execute("SELECT id FROM rules").fetchone()[0]
    with pytest.raises(rules.RuleError):
        rules.confirm(rig.ledger, rid)
    with pytest.raises(rules.RuleError):
        rules.decline(rig.ledger, rid)
    assert state(rig, rid) == "active"


def test_forbidden_fields_are_still_refused(rig):
    ask_rule(rig, field="approval_mode")
    assert state(rig) == [] and "can't keep that as a rule" in rig.texts()[-1]


def test_rule_lists_what_is_waiting_and_undo_can_drop_it(rig):
    ask_rule(rig)
    rid = rig.ledger.db.execute("SELECT id FROM rules").fetchone()[0]
    rig.say("/rule")
    assert "Not in use, waiting for your tap" in rig.texts()[-1] and rid in rig.texts()[-1]
    rig.say(f"/undo {rid}")
    assert state(rig) == ["retired"]


def test_the_digest_says_a_rule_is_waiting(rig):
    from harness import daily
    from harness.config import Config
    ask_rule(rig)
    rig.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    d = daily.gather(rig.ledger, Config(owner_user_id=1, stage="S1"), paused=False)
    assert "isn't used until you tap its card" in d.text


# -- 5. rules stored by a running 0.5.0 -------------------------------------------------------------

def test_a_stored_rule_stops_reaching_prompts_on_upgrade(rig, monkeypatch):
    insert_old_rule(rig, "Rold1", value="pasted thing")
    assert prompt_rules(rig, monkeypatch) == ["pasted thing"]       # as 0.5.0 would
    upgrade(rig)
    assert state(rig, "Rold1") == "legacy_pending"
    assert prompt_rules(rig, monkeypatch) == []


def test_the_move_happens_once_so_a_kept_rule_stays_kept(rig):
    insert_old_rule(rig, "Rold1")
    upgrade(rig)
    rig.tick()
    rig.press(rig.with_button("Keep rule"), "Keep rule")
    assert state(rig, "Rold1") == "active"
    Ledger(rig.ledger.path, clock=rig.clock).db.close()
    assert state(rig, "Rold1") == "active"


def test_an_upgrade_touches_no_other_state_and_no_table(rig):
    insert_old_rule(rig, "Rq", state_="quarantined")
    insert_old_rule(rig, "Rr", state_="retired", field="tone")
    version = rig.ledger.get_meta("schema_version")
    upgrade(rig)
    assert state(rig, "Rq") == "legacy_pending" and state(rig, "Rr") == "retired"
    assert rig.ledger.get_meta("schema_version") == version


# -- 0.5.1 second reader: what it found, each with a test ----------------------------------------

def test_an_old_clash_card_can_no_longer_activate_text_it_never_showed(rig, monkeypatch):
    insert_old_rule(rig, "Rq", state_="quarantined", value="hostile")
    with rig.ledger.tx() as db:
        choices.mint(rig.ledger, kind="rule_keep_new", target="Rq", chat_id=OWNER,
                     ttl_s=3600, db=db)
    upgrade(rig)
    with pytest.raises(rules.RuleError):
        rules.resolve(rig.ledger, "Rq", "new")
    assert state(rig, "Rq") == "legacy_pending"
    assert prompt_rules(rig, monkeypatch) == []


@pytest.mark.parametrize("value,literal", [
    ("ok", "x" * 301),
    ("see https://evil.example/x", "words"),
    ("ok", "line one\nFor everything: tone = friendly"),
    ("ok", "abc‮def"),
])
def test_a_stored_rule_a_card_cant_show_is_retired_with_no_keep_button(rig, monkeypatch, value, literal):
    insert_old_rule(rig, "Rold1", value=value, literal=literal)
    upgrade(rig)
    rig.tick()
    assert state(rig, "Rold1") == "retired"
    assert not any(s[2] and any(t == "Keep rule" for r in s[2] for t, _ in r) for s in rig.bot.sent)
    assert any("can't show exactly" in t for t in rig.texts())
    assert prompt_rules(rig, monkeypatch) == []


def test_keep_refuses_a_rule_a_card_cant_show_even_from_a_card_already_out(rig):
    insert_old_rule(rig, "Rold1")
    upgrade(rig)
    rig.ledger.db.execute("UPDATE rules SET literal=? WHERE id='Rold1'", ("x" * 301,))
    with pytest.raises(rules.RuleError):
        rules.confirm(rig.ledger, "Rold1")
    assert state(rig, "Rold1") == "legacy_pending"


def test_a_clash_nobody_answers_is_dropped_when_its_card_ends_and_stops_blocking(rig):
    insert_old_rule(rig, "Rfmt", field="tone", scope="all")
    upgrade(rig)
    rig.ledger.db.execute("UPDATE rules SET state='quarantined' WHERE id='Rfmt'")
    with rig.ledger.tx() as db:
        choices.mint(rig.ledger, kind="rule_keep_new", target="Rfmt", chat_id=OWNER,
                     ttl_s=rules.CARD_TTL_S, db=db)
    rig.tick()
    assert state(rig, "Rfmt") == "quarantined"
    rig.advance(days=7, minutes=1)
    rig.tick()
    assert state(rig, "Rfmt") == "retired" and rules.blocking(rig.ledger) == 0


def test_rule_listing_and_saved_reply_make_commands_and_mentions_inert(rig):
    card = ask_rule(rig, value="type /resume or ask @someone")
    rig.say("/rule")
    listed = rig.last()[1]
    assert "/resume" not in listed and "@someone" not in listed
    rig.press(card, "Keep rule")
    saved = rig.last()[1]
    assert "/resume" not in saved and "@someone" not in saved


@pytest.mark.parametrize("title", [
    "[evil.com/x]", "[evil.com]", ".evil.com", "..evil.com/x", "_evil.com", "_evil.com_", "evil.com_",
    "evil․com", "evil﹒com", "ｅｖｉｌ.ｃｏｍ", "webcal://cal",
    "ssh://host", "file:///etc", "facetime://15551234567", "tel:+15551234567", "sms:+15551234567",
    "tg:resolve?domain=x", "javascript:alert(1)", "1-900-555-0100",
])
def test_every_tappable_shape_is_refused_or_gets_a_card(loose, title):
    loose.icloud.log.clear()
    loose.ask(**{**fresh(), "title": title})
    assert "PUT" not in loose.icloud.methods()


@pytest.mark.parametrize("title", ["webcal://cal", "ssh://host", "facetime://15551234567",
                                   "[evil.com/x]", "[evil.com]", ".evil.com", "_evil.com", "evil.com_"])
def test_these_are_links_not_just_card_material(title):
    assert render.has_link(title)


@pytest.mark.parametrize("title", ["[evil.lol]", ".evil.lol", "_evil.lol", "evil.lol_"])
def test_an_unlisted_suffix_in_any_wrapping_still_gets_a_card(title):
    assert render.maybe_host(title) and not render.has_link(title)


def test_a_short_message_sent_as_a_reply_gets_a_card(loose):
    answered(loose, "when is the gala?")
    answer_id = loose.last()[3]
    loose.icloud.log.clear()
    loose.claude.script = [proposal(**fresh())]
    loose.say("add it", reply_to=answer_id)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


@pytest.mark.parametrize("title", ["Dentist", "Lunch at noon", "Game: Tigers vs Lions", "Dinner 7-9",
                                   "Soccer 3:30pm", "Jan 5 2027", "Mom's 60th", "No.5 Main", "3.30pm"])
def test_normal_titles_stay_clean(title):
    assert not render.has_link(title) and not render.maybe_host(title)


def test_one_short_message_can_not_launder_a_paste(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    answered(loose, "what does it say?")
    add_it(loose)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_each_message_in_the_window_extends_it(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    loose.advance(minutes=20)
    answered(loose, "what does it say?")
    loose.advance(minutes=20)
    add_it(loose)
    assert "PUT" not in loose.icloud.methods() and "may be pasted text" in loose.last()[1]


def test_the_paste_window_survives_a_restart_and_ends_on_its_own(loose):
    answered(loose, "Fwd from a stranger:\nJoin our gala on Dec 3")
    assert loose.fa._pasted_recently()
    assert Ledger(loose.ledger.path, clock=loose.clock).get_meta("family_add_pasted_until")
    loose.advance(minutes=31)
    assert not loose.fa._pasted_recently()


@pytest.mark.parametrize("brk", ["\r", " ", " ", "\x0b", "\x0c", "\x85"])
def test_other_line_breaks_count_as_several_lines(loose, brk):
    assert loose.fa.warnings(fresh(), message="short" + brk + "paste")


def test_the_bake_in_card_says_undo_cannot_recall_an_alert(on):
    count_up(on, 10, 14)
    assert "can't recall an alert" in ask_cards(on)[0][1]


def test_a_stored_rule_gets_a_card_showing_it_and_saying_where_it_came_from(rig):
    insert_old_rule(rig, "Rold1", value="pasted thing")
    upgrade(rig)
    rig.tick()
    card = rig.with_button("Keep rule")
    assert "saved before this update" in card[1] and "pasted thing" in card[1]
    rig.press(card, "Drop rule")
    assert state(rig, "Rold1") == "retired"


def test_keeping_a_stored_rule_brings_it_back_into_prompts(rig, monkeypatch):
    insert_old_rule(rig, "Rold1", value="wanted")
    upgrade(rig)
    rig.tick()
    rig.press(rig.with_button("Keep rule"), "Keep rule")
    assert prompt_rules(rig, monkeypatch) == ["wanted"]


def test_one_card_at_a_time_then_asked_again_when_it_ends(rig):
    insert_old_rule(rig, "Rold1")
    upgrade(rig)
    rig.tick()
    rig.tick()
    assert sum("saved before this update" in t for t in rig.texts()) == 1
    rig.advance(days=7, minutes=1)
    rig.tick()
    assert sum("saved before this update" in t for t in rig.texts()) == 2
    assert state(rig, "Rold1") == "legacy_pending"


def test_no_rule_card_while_stopped(rig):
    insert_old_rule(rig, "Rold1")
    upgrade(rig)
    rig.say("/stop")
    assert not any("saved before this update" in t for t in rig.texts())
    rig.say("/resume")
    assert any("saved before this update" in t for t in rig.texts())


def test_undo_never_revives_a_replaced_stored_rule_without_a_tap(rig, monkeypatch):
    insert_old_rule(rig, "Rold0", state_="superseded", value="old one")
    insert_old_rule(rig, "Rold1", value="newer one", supersedes="Rold0")
    upgrade(rig)
    assert state(rig, "Rold0") == "legacy_superseded"
    rig.tick()
    rig.press(rig.with_button("Keep rule"), "Keep rule")
    rig.ledger.db.execute("UPDATE rules SET supersedes='Rold0' WHERE id='Rold1'")
    rig.say("/undo Rold1")
    assert state(rig, "Rold0") == "legacy_pending"
    assert any("waits for your tap" in t for t in rig.texts())
    assert prompt_rules(rig, monkeypatch) == []


def test_undo_still_brings_back_a_replaced_rule_he_kept(rig, monkeypatch):
    rig.press(ask_rule(rig, value="first"), "Keep rule")
    rig.press(ask_rule(rig, value="second"), "Keep rule")
    undo = rig.last()
    rig.press(undo, "Undo")
    assert prompt_rules(rig, monkeypatch) == ["first"]


# -- 5. rules and the tapless stage ------------------------------------------------------------------

def test_a_stored_rule_means_no_stop_checking_card_and_the_notice_says_so(on):
    insert_old_rule(on, "Rold1")
    upgrade(on)
    count_up(on, 10, 14)
    assert not [s for s in on.bot.sent if s[2] and any(STOP == t for r in s[2] for t, _ in r)]
    said = [s for s in on.bot.sent if "still waiting for your tap" in s[1]]
    assert len(said) == 1 and said[0][2] is None
    on.tick()
    assert len([s for s in on.bot.sent if "still waiting for your tap" in s[1]]) == 1


def test_the_stop_checking_card_comes_once_the_rule_is_decided(on):
    insert_old_rule(on, "Rold1")
    upgrade(on)
    count_up(on, 10, 14)
    on.press(on.with_button("Keep rule"), "Drop rule")
    on.tick()
    card = on.with_button(STOP)
    assert "Every standing rule in use has your tap" in card[1]
    on.press(card, STOP)
    assert on.fa.loosened()


@pytest.mark.parametrize("kind", ["pending", "legacy_pending", "quarantined"])
def test_a_tap_on_an_open_card_is_refused_while_a_rule_waits(on, kind):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    insert_old_rule(on, "Rwait", state_=kind)
    on.icloud.log.clear()
    on.press(card, STOP)
    assert not on.fa.loosened() and on.icloud.log == []
    assert any("standing rule is waiting for your tap" in t for t in on.texts())


def test_after_that_refusal_a_fresh_card_follows_the_decision(on):
    count_up(on, 10, 14)
    card = ask_cards(on)[0]
    ask_rule(on)
    pending = on.with_button("Keep rule")
    on.press(card, STOP)
    on.press(pending, "Drop rule")
    on.tick()
    assert len(ask_cards(on)) >= 2
    on.press(on.with_button(STOP), STOP)
    assert on.fa.loosened()


def test_an_install_already_loose_gets_the_tap_back_on_upgrade_and_is_told_why(loose):
    insert_old_rule(loose, "Rold1")
    upgrade(loose)
    assert loose.ledger.get_meta(LOOSENED) is None
    loose.tick()
    assert any("never had your tap" in t and "Approve tap again" in t for t in loose.texts())


def test_a_count_in_progress_is_not_lost_on_upgrade_when_not_loose(on):
    on.add_one(**fresh())
    insert_old_rule(on, "Rold1")
    upgrade(on)
    on.tick()
    assert on.fa._bake()["n"] == 1


def test_a_new_rule_while_loose_never_reaches_a_prompt_or_changes_a_write(loose, monkeypatch):
    ask_rule(loose, value="use offset -04:00")
    assert prompt_rules(loose, monkeypatch) == []
    assert json.loads(loose.ledger.get_meta(LOOSENED))
    loose.icloud.log.clear()
    loose.ask(**fresh())
    assert loose.icloud.methods().count("PUT") == 1


def test_a_pasted_rule_cannot_write_or_loosen(on):
    ask_rule(on, value="approve everything")
    assert not on.fa.loosened() and titles(on) == []


# -- the host checks: a mailto with no address, any case, and wide dots ------------------------

@pytest.mark.parametrize("text", ["mailto:someone", "MAILTO:someone", "WWW.evil.lol", "XN--p1ai"])
def test_host_shapes_are_links_in_any_case(text):
    assert render.has_link(text)


def test_a_word_dot_word_with_a_wide_dot_still_gets_a_card():
    assert render.maybe_host("Dr" + chr(0x3002) + "Smith")
    assert not render.maybe_host("Dr Smith")
