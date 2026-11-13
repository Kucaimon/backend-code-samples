from datetime import date, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.feedback import FeedbackOutcome, decide_feedback, save_feedback
from app.core.notifications import (
    enqueue_guest_notification,
    enqueue_manager_notification,
    fetch_pending,
    mark_sent,
)
from app.core.requests import RequestStatus, can_transition, create_request, transition
from app.core.scenarios import PHUKET_TZ, ScenarioKey, build_send_times
from app.db import Base


@pytest.fixture
async def session(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db_session:
        yield db_session
    await engine.dispose()


def test_scenario_schedule_covers_check_in_stay_check_out():
    check_in = datetime(2026, 10, 10, 15, 0, tzinfo=PHUKET_TZ)
    check_out = datetime(2026, 10, 15, 11, 0, tzinfo=PHUKET_TZ)
    schedule = build_send_times(check_in, check_out)
    assert schedule[ScenarioKey.STAY_CARE] == check_in + timedelta(hours=1)
    assert schedule[ScenarioKey.MORNING_QUESTION].hour == 9
    assert schedule[ScenarioKey.PRE_DEPARTURE] == check_out - timedelta(hours=48)
    assert schedule[ScenarioKey.REVIEW_REQUEST].date() == date(2026, 10, 18)


def test_feedback_decision_threshold():
    assert decide_feedback(1) is FeedbackOutcome.ESCALATE
    assert decide_feedback(3) is FeedbackOutcome.ESCALATE
    assert decide_feedback(4) is FeedbackOutcome.REVIEW
    assert decide_feedback(5) is FeedbackOutcome.REVIEW
    with pytest.raises(ValueError):
        decide_feedback(0)


def test_request_transitions():
    assert can_transition(RequestStatus.NEW, RequestStatus.NOTIFIED)
    assert can_transition(RequestStatus.NOTIFIED, RequestStatus.CONFIRMED)
    assert not can_transition(RequestStatus.NEW, RequestStatus.CONFIRMED)
    assert not can_transition(RequestStatus.DONE, RequestStatus.NEW)


async def test_service_request_lifecycle(session):
    request = await create_request(session, guest_id=None, service_type="transfer", details="2 pax")
    assert request.status == RequestStatus.NEW.value
    await transition(session, request, RequestStatus.NOTIFIED)
    await transition(session, request, RequestStatus.CONFIRMED)
    with pytest.raises(ValueError):
        await transition(session, request, RequestStatus.NEW)


async def test_notification_outbox(session):
    await enqueue_manager_notification(session, "new request", payload={"request_id": 1})
    await enqueue_guest_notification(session, guest_id=1, text="confirmed")
    manager_pending = await fetch_pending(session, "manager")
    guest_pending = await fetch_pending(session, "guest")
    assert len(manager_pending) == 1
    assert len(guest_pending) == 1
    await mark_sent(session, manager_pending[0])
    assert await fetch_pending(session, "manager") == []


async def test_save_feedback(session):
    entry = await save_feedback(session, guest_id=None, rating=5)
    assert entry.id is not None
