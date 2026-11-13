"""Beds24 adapter: payload mapping, token handling and diagnostics."""
from datetime import date

import httpx
import pytest

from app.adapters import beds24
from app.adapters.beds24 import (
    Beds24AuthError,
    RealBeds24,
    booking_from_api,
    normalize_status,
)


def make_adapter(handler, **kwargs) -> RealBeds24:
    adapter = RealBeds24(api_key="test-token", **kwargs)
    adapter._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://api.beds24.com/v2",
    )
    return adapter


def path_of(request: httpx.Request) -> str:
    """Request path without the /v2 base prefix."""
    return request.url.path.removeprefix("/v2")


def test_booking_from_api_maps_spec_fields():
    booking = booking_from_api(
        {
            "id": 4321,
            "propertyId": 7,
            "status": "confirmed",
            "arrival": "2026-01-10",
            "departure": "2026-01-17",
            "firstName": "John",
            "lastName": "Smith",
            "email": "john@example.com",
            "phone": "+66 81 234 5678",
            "mobile": "+66 89 000 1122",
            "lang": "th",
            "propertyName": "Pilot Villa",
        }
    )
    assert booking is not None
    assert booking.beds24_id == "4321"
    assert booking.guest_name == "John Smith"
    assert booking.phone == "+66 81 234 5678"
    assert booking.mobile == "+66 89 000 1122"
    assert booking.check_in == date(2026, 1, 10)
    assert booking.check_out == date(2026, 1, 17)
    assert booking.language == "th"
    assert booking.status == "confirmed"
    assert booking.property_id == 7
    assert booking.object_name == "Pilot Villa"


def test_booking_without_id_is_ignored():
    assert booking_from_api({"firstName": "No"}) is None


def test_status_spelling_is_normalized():
    assert normalize_status("canceled") == "cancelled"
    assert normalize_status("Cancelled") == "cancelled"
    assert normalize_status("pending") == "pending"
    assert normalize_status("Awaiting Payment") == "pending"


@pytest.mark.asyncio
async def test_requests_send_token_header_and_parse_bookings():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["token"] = request.headers.get("token")
        seen["path"] = path_of(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": 1,
                        "arrival": "2026-02-01",
                        "departure": "2026-02-05",
                        "firstName": "A",
                        "phone": "+1",
                    }
                ]
            },
        )

    bookings = await make_adapter(handler).fetch_bookings()
    assert seen["token"] == "test-token"
    assert seen["path"] == "/bookings"
    assert [b.beds24_id for b in bookings] == ["1"]


@pytest.mark.asyncio
async def test_diagnose_reports_visible_records_for_a_valid_token():
    def handler(request: httpx.Request) -> httpx.Response:
        if path_of(request) == "/authentication/details":
            return httpx.Response(
                200, json={"validToken": True, "token": {"scopes": ["read:bookings"]}}
            )
        if path_of(request) == "/properties":
            return httpx.Response(200, json={"data": [{"id": 1, "name": "Villa"}]})
        return httpx.Response(200, json={"data": [{"id": 10}]})

    result = await make_adapter(handler).diagnose()
    assert result["valid_token"] is True
    assert result["scopes"] == ["read:bookings"]
    assert result["visible_properties"] == 1
    assert result["visible_bookings"] == 1


@pytest.mark.asyncio
async def test_diagnose_flags_token_that_sees_nothing():
    """The reported failure mode: token is valid but shows no bookings."""

    def handler(request: httpx.Request) -> httpx.Response:
        if path_of(request) == "/authentication/details":
            return httpx.Response(200, json={"validToken": True, "token": {"scopes": []}})
        return httpx.Response(200, json={"data": []})

    result = await make_adapter(handler).diagnose()
    assert result["valid_token"] is True
    assert result["scopes"] == []
    assert result["visible_properties"] == 0


@pytest.mark.asyncio
async def test_rejected_token_raises_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Invalid token"})

    with pytest.raises(Beds24AuthError) as excinfo:
        await make_adapter(handler).fetch_bookings()
    assert "Invalid token" in str(excinfo.value)


@pytest.mark.asyncio
async def test_invite_code_exchange_returns_refresh_token(monkeypatch):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, path, params=None):
            assert path == "/authentication/setup"
            assert params == {"inviteCode": "INVITE123"}
            return httpx.Response(200, json={"refreshToken": "REFRESH-XYZ"})

    monkeypatch.setattr(beds24.httpx, "AsyncClient", FakeClient)
    assert await beds24.exchange_invite_code("INVITE123") == "REFRESH-XYZ"


@pytest.mark.asyncio
async def test_invite_code_exchange_failure_explains_one_time_code(monkeypatch):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, path, params=None):
            return httpx.Response(400, json={"error": "Invite code not found"})

    monkeypatch.setattr(beds24.httpx, "AsyncClient", FakeClient)
    with pytest.raises(Beds24AuthError, match="one-time"):
        await beds24.exchange_invite_code("USED-CODE")


def test_adapter_requires_a_token():
    with pytest.raises(Beds24AuthError):
        RealBeds24()
