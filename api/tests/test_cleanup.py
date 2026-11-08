"""Per-segment cleanup validation and the deterministic fallback (cleanup.py)."""
import json
from pathlib import Path

import pytest

import cleanup
import main
from schemas import RefinedSegment, RefineGemini

CASES = json.loads((Path(__file__).parent / "fixtures" / "refine_cleanup_cases.json").read_text())


def accepted(raw, candidate):
    return cleanup.check_cleanup(raw, candidate).ok


# ---------- safe edits are accepted ----------

def test_removes_um_and_uh_without_changing_the_remaining_words():
    raw = "Okay, um, so today we're learning about dynamics. Here is the, uh, free-body diagram."
    assert accepted(raw, "Okay, so today we're learning about dynamics. Here is the free-body diagram.")


def test_removes_accidental_duplicated_words_and_phrases():
    assert accepted("so today we're, we're learning about the the force", "So today we're learning about the force.")
    assert accepted("We're gonna, we're gonna look at osmosis", "We're gonna look at osmosis.")


@pytest.mark.parametrize("raw, cleaned", [
    ("it goes all the way down the, sorry, along the mountain", "It goes all the way along the mountain."),
    ("the mito, the mitochondria makes energy", "The mitochondria makes energy."),
    ("this is photo photosynthesis", "This is photosynthesis."),
])
def test_handles_a_clear_abandoned_false_start(raw, cleaned):
    assert accepted(raw, cleaned)


@pytest.mark.parametrize("raw, cleaned", [
    ("so the my toe con dree a makes a tee pee", "So the mitochondria makes ATP."),
    ("it happens in the site oh plaz", "It happens in the cytoplasm."),
    ("gee no type is the genes", "Genotype is the genes."),
    ("the rye bo zomes on the rough E R", "The ribosomes on the rough ER"),
    ("a human cell has twenty three pairs of chromosomes", "A human cell has 23 pairs of chromosomes."),
])
def test_accepts_sound_alike_corrections_of_misheard_terms_and_spelled_numbers(raw, cleaned):
    assert accepted(raw, cleaned)


def test_a_segment_of_only_filler_may_become_empty_but_content_may_not():
    assert accepted("Um.", "") and accepted("Uh-huh. Okay.", "")
    assert not accepted("Okay, the cell.", "")


# ---------- meaning changes are rejected ----------

def test_preserves_negation():
    raw = "The force is not 10 newtons, it's 20 newtons."
    assert accepted(raw, raw)
    assert cleanup.check_cleanup(raw, "The force is 10 newtons, it's 20 newtons.").reason == "negation_changed"
    assert cleanup.check_cleanup("they are not able to", "They are notable to").reason == "negation_changed"


@pytest.mark.parametrize("cleaned", [
    "The force is not 12 newtons, it's 20 newtons.",
    "The force is not 10 newtons.",
    "The force is not ten newtons, it's twenty newtons, so 30 total.",
])
def test_preserves_numbers(cleaned):
    assert not accepted("The force is not 10 newtons, it's 20 newtons.", cleaned)


@pytest.mark.parametrize("raw, cleaned", [
    ("water moves into a hypertonic solution", "Water moves into a hypotonic solution."),
    ("the rate will increase", "The rate will decrease."),
    ("g is 9.8 meters per second squared", "g is 9.81 meters per second squared."),
])
def test_preserves_technical_claims(raw, cleaned):
    assert not accepted(raw, cleaned)


@pytest.mark.parametrize("cleaned", [
    "The mountain contains a continuous dirt trail that traverses its terrain.",
    "The teacher discussed a mountain path.",
    "This here is the dirt trail, and it goes along the mountain.",
    "This here is the dirt path, and it goes all the way along the mountain, which formed by erosion.",
])
def test_rejects_genuine_paraphrasing_summaries_and_added_content(cleaned):
    raw = "Okay so um this here is the dirt path, and uh it goes all the way down the, sorry, along the mountain."
    assert not accepted(raw, cleaned)


def test_a_false_start_cannot_swallow_words_he_meant_to_keep():
    raw = "and it, it goes all the way down the, sorry, along the mountain"
    assert accepted(raw, "It goes all the way along the mountain.")
    assert not accepted(raw, "It goes along the mountain.")


def test_rejects_dropping_a_meaningful_list_item_or_explanation():
    assert not accepted("the cell, the nucleus, and the membrane", "The nucleus and the membrane.")
    assert not accepted("the my toe con dree a makes a tee pee can someone close the door", "The mitochondria make ATP.")


# ---------- deterministic fallback ----------

@pytest.mark.parametrize("raw, expected", [
    ("Okay, um, so today we're, we're learning about dynamics.", "Okay, so today we're learning about dynamics."),
    ("Here is the, uh, free-body diagram.", "Here is the free-body diagram."),
    ("Um, so the mitochondria", "So the mitochondria"),
    ("We're gonna, we're gonna look at it, uh.", "We're gonna look at it."),
    ("Um.", ""),
    ("The force is not 10 newtons, it's 20 newtons.", "The force is not 10 newtons, it's 20 newtons."),
])
def test_basic_cleanup_removes_only_obvious_disfluencies(raw, expected):
    assert cleanup.basic_cleanup(raw) == expected


def test_basic_cleanup_keeps_meaningful_repeats_numbers_and_negations():
    raw = "I know that that is very very true, no no, it is 10 10 newtons and not not zero"
    assert cleanup.basic_cleanup(raw) == raw


# ---------- evaluation fixture ----------

@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_expected_cleanup_is_accepted_segment_by_segment(case):
    segments = [{"id": f"s{i}", "raw_text": s["raw"]} for i, s in enumerate(case["segments"])]
    expected = [s["expected"] for s in case["segments"]]
    out = RefineGemini(text=" ".join(e for e in expected if e), segments=[
        RefinedSegment(id=f"s{i}", text=text) for i, text in enumerate(expected)
    ])

    cleaned, outcomes = main.choose_refined_segments(segments, out)

    assert cleaned == expected
    assert not any(k.startswith("rejected:") for k in outcomes)
    for s in case["segments"]:
        assert accepted(s["raw"], cleanup.basic_cleanup(s["raw"]))
