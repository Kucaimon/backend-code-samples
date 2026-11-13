from app.adapters.beds24 import MockBeds24
from app.adapters.llm import MockLLM
from app.core.dialogs import ESCALATION_MARKER, needs_escalation
from app.i18n import t


async def test_mock_beds24_returns_fixture_bookings():
    bookings = await MockBeds24().fetch_bookings()
    assert bookings
    assert bookings[0].beds24_id


async def test_mock_llm_echoes_request():
    reply = await MockLLM().complete("system", "hello")
    assert "hello" in reply


def test_i18n_has_ru_and_en_welcome():
    assert t("ru", "welcome") != "welcome"
    assert t("en", "welcome") != "welcome"
    assert t("ru", "welcome") != t("en", "welcome")


def test_escalation_marker_detected():
    assert needs_escalation(f"some reply {ESCALATION_MARKER}")
    assert not needs_escalation("normal reply")
