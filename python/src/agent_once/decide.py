from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .ledger import GuardPolicy, LedgerEvent

DecisionKind = Literal["execute", "replay", "in_doubt"]


@dataclass(frozen=True)
class DecisionCall:
    run_instance: str
    session_explicit: bool
    intent_key_explicit: bool
    policy: GuardPolicy


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    occurrence: int
    reason: str
    event: LedgerEvent | None = None


def _execute(occurrence: int, reason: str) -> Decision:
    return Decision("execute", occurrence, reason)


def _about(kind: DecisionKind, event: LedgerEvent, reason: str) -> Decision:
    return Decision(kind, event.occurrence, reason, event)


def _decide_failed(latest: LedgerEvent, within_window: bool, call: DecisionCall) -> Decision:
    if latest.detail.get("failure_kind") == "not_dispatched":
        return _execute(latest.occurrence + 1, "not_dispatched")
    if call.policy == "block-on-doubt":
        return _about("in_doubt", latest, "failed_block_on_doubt")
    if within_window:
        return _about("in_doubt", latest, "failed_within_window")
    return _execute(latest.occurrence + 1, "failed_after_window")


def _decide_happened(latest: LedgerEvent, within_window: bool, call: DecisionCall) -> Decision:
    if call.intent_key_explicit:
        return _about("replay", latest, "replay_explicit_intent")
    undelivered = latest.state == "reconciled" or latest.detail.get("delivery") == "cancelled"
    if undelivered and within_window:
        return _about("replay", latest, "replay_undelivered")
    other_run = latest.run_instance != call.run_instance
    if other_run and call.session_explicit:
        return _about("replay", latest, "replay_rerun_explicit_session")
    if other_run and within_window:
        return _about("replay", latest, "replay_rerun_within_window")
    return _execute(latest.occurrence + 1, "deliberate_repeat")


def decide(
    latest: LedgerEvent | None, now_ms: int, retry_window_ms: int, call: DecisionCall
) -> Decision:
    if latest is None:
        return _execute(0, "new")
    if latest.expires_at_ms <= now_ms:
        return _execute(latest.occurrence + 1, "expired")
    within_window = now_ms < latest.at_ms + retry_window_ms
    if latest.state in ("intended", "sent"):
        return _about("in_doubt", latest, "outcome_unknown")
    if latest.state == "failed":
        return _decide_failed(latest, within_window, call)
    if latest.state == "reconciled" and latest.detail.get("outcome") == "not_happened":
        return _execute(latest.occurrence + 1, "reconciled_not_happened")
    return _decide_happened(latest, within_window, call)
