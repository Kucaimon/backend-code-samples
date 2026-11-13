"""Beds24 PMS adapter (API v2).

Field mapping follows the official OpenAPI spec (apiV2.yaml):
  GET /bookings   -> id, propertyId, status, arrival, departure,
                     firstName, lastName, email, phone, mobile, lang
  GET /properties -> id, name

Auth: header "token: {token}". Token scopes required:
read:bookings, read:bookings-personal, read:properties.

Two token types are supported:
  * long-life read-only token  -> used directly (BEDS24_API_KEY);
  * invite code / refresh token -> exchanged per Beds24 OAuth flow
    (GET /authentication/setup, then GET /authentication/token); access
    tokens expire after 24h and are refreshed automatically.
"""
import logging
from datetime import UTC, date, datetime, timedelta

import httpx

from app.adapters.base import BookingData
from app.config import get_settings

logger = logging.getLogger(__name__)

BEDS24_BASE_URL = "https://api.beds24.com/v2"

# Access tokens issued from a refresh token live ~24h; renew a bit earlier.
ACCESS_TOKEN_LIFETIME = timedelta(hours=24)
REFRESH_SAFETY_MARGIN = timedelta(minutes=30)


class Beds24Error(Exception):
    """Base error for Beds24 API problems."""


class Beds24AuthError(Beds24Error):
    """Token is missing, expired or lacks scopes - operator action required."""


def _extract_error(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200] or f"HTTP {response.status_code}"
    if isinstance(body, dict):
        return str(body.get("error") or body.get("message") or body)[:300]
    return str(body)[:300]


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def normalize_status(raw_status: str | None) -> str:
    """Map Beds24 booking status to our canonical values.

    Beds24 sends: new, pending, awaiting payment, confirmed, checked in,
    checked out, canceled/cancelled, no show.
    """
    status = (raw_status or "").lower().strip()
    if not status:
        return "active"
    if status.startswith("cancel"):
        return "cancelled"
    if status.startswith("new"):
        return "pending"
    if status.startswith("await"):
        return "pending"
    return status


def booking_from_api(raw: dict) -> BookingData | None:
    """Map a Beds24 booking object (API or webhook payload) to BookingData."""
    booking_id = raw.get("id")
    if booking_id is None:
        return None
    name = " ".join(filter(None, [raw.get("firstName"), raw.get("lastName")])).strip() or None
    return BookingData(
        beds24_id=str(booking_id),
        guest_name=name,
        phone=raw.get("phone") or None,
        mobile=raw.get("mobile") or None,
        email=raw.get("email") or None,
        language=(raw.get("lang") or "").lower(),
        check_in=parse_date(raw.get("arrival")),
        check_out=parse_date(raw.get("departure")),
        property_id=raw.get("propertyId"),
        object_name=raw.get("propertyName") or None,
        status=normalize_status(raw.get("status")),
    )


class MockBeds24:
    """Fixture-driven adapter used until credentials arrive."""

    async def fetch_bookings(self) -> list[BookingData]:
        today = datetime.now(UTC).date()
        return [
            BookingData(
                beds24_id="MOCK-1001",
                guest_name="John Smith",
                phone="+66000000001",
                language="en",
                check_in=today,
                check_out=today + timedelta(days=5),
                object_name="Pilot Villa 1",
                property_id=1,
            ),
            BookingData(
                beds24_id="MOCK-1002",
                guest_name="Ivan Petrov",
                phone="+79000000002",
                language="ru",
                check_in=today + timedelta(days=2),
                check_out=today + timedelta(days=9),
                object_name="Pilot Villa 1",
                property_id=1,
            ),
        ]

    async def fetch_booking(self, beds24_id: str) -> BookingData | None:
        for booking in await self.fetch_bookings():
            if booking.beds24_id == beds24_id:
                return booking
        return None

    async def fetch_property_names(self) -> dict[int, str]:
        return {1: "Pilot Villa 1"}

    async def diagnose(self) -> dict:
        return {
            "valid_token": True,
            "mock": True,
            "scopes": ["read:bookings", "read:bookings-personal", "read:properties"],
            "visible_properties": 1,
            "visible_bookings": 2,
        }


async def exchange_invite_code(invite_code: str) -> str:
    """Exchange a one-time invite code for a long-life refresh token.

    Beds24: GET /authentication/setup?inviteCode=...
    The invite code is created in Settings -> Account -> Access.
    """
    async with httpx.AsyncClient(base_url=BEDS24_BASE_URL, timeout=20) as client:
        response = await client.get("/authentication/setup", params={"inviteCode": invite_code})
    if response.status_code != 200:
        raise Beds24AuthError(
            f"Invite code exchange failed (HTTP {response.status_code}): "
            f"{_extract_error(response)}. "
            "The code is one-time: it may already be used or expired."
        )
    body = response.json()
    refresh_token = body.get("refreshToken") or body.get("refresh_token")
    if not refresh_token:
        raise Beds24AuthError(f"Invite code exchange returned no refresh token: {body}")
    return str(refresh_token)


async def refresh_access_token(refresh_token: str) -> tuple[str, datetime]:
    """Mint a short-lived access token (~24h) from a refresh token.

    Beds24: GET /authentication/token?refreshToken=...
    Returns (access_token, expires_at).
    """
    async with httpx.AsyncClient(base_url=BEDS24_BASE_URL, timeout=20) as client:
        response = await client.get("/authentication/token", params={"refreshToken": refresh_token})
    if response.status_code != 200:
        raise Beds24AuthError(
            f"Refresh token exchange failed (HTTP {response.status_code}): "
            f"{_extract_error(response)}. Request a new invite code from the client."
        )
    body = response.json()
    access_token = body.get("token") or body.get("accessToken")
    if not access_token:
        raise Beds24AuthError(f"Refresh exchange returned no access token: {body}")
    return str(access_token), datetime.now(UTC) + ACCESS_TOKEN_LIFETIME


class RealBeds24:
    """Async client for Beds24 API v2 (read-only scopes).

    Accepts either a long-life read-only token (api_key) or a refresh token,
    in which case short-lived access tokens are minted and renewed lazily.
    """

    def __init__(
        self,
        api_key: str = "",
        refresh_token: str = "",
        token_kind: str = "api_key",
    ) -> None:
        if not api_key and not refresh_token:
            raise Beds24AuthError(
                "Beds24: neither api_key nor refresh_token is configured. "
                "See docs/beds24-token-setup.md"
            )
        self._api_key = api_key
        self._refresh_token = refresh_token
        self._token_kind = (token_kind or "api_key").lower()
        self._access_token = api_key
        self._access_expires_at: datetime | None = None
        self._client = httpx.AsyncClient(
            base_url=get_settings().beds24_base_url or BEDS24_BASE_URL, timeout=20
        )

    async def _auth_header(self) -> dict[str, str]:
        if self._refresh_token:
            expired = self._access_expires_at is None or (
                datetime.now(UTC) + REFRESH_SAFETY_MARGIN >= self._access_expires_at
            )
            if expired:
                self._access_token, self._access_expires_at = await refresh_access_token(
                    self._refresh_token
                )
                logger.info("Beds24: access token minted from refresh token")
        if not self._access_token:
            raise Beds24AuthError("Beds24: no usable access token")
        return {"token": self._access_token}

    async def _get(self, path: str, params: dict | None = None) -> dict:
        response = await self._client.get(path, params=params, headers=await self._auth_header())
        if response.status_code == 401:
            # A long-life token may have expired; a refresh token can be re-minted once.
            if self._refresh_token:
                self._access_token, self._access_expires_at = await refresh_access_token(
                    self._refresh_token
                )
                response = await self._client.get(
                    path, params=params, headers=await self._auth_header()
                )
            if response.status_code == 401:
                raise Beds24AuthError(
                    f"Beds24 rejected the token on {path}: {_extract_error(response)}. "
                    "Check token scopes and expiry in Settings -> Account -> Access."
                )
        if response.status_code >= 400:
            raise Beds24Error(f"Beds24 {path} failed (HTTP {response.status_code}): {_extract_error(response)}")
        return response.json()

    async def diagnose(self) -> dict:
        """Token diagnostics: validity, scopes, and what the token can actually see."""
        body = await self._client.get("/authentication/details", headers=await self._auth_header())
        details = body.json()
        valid = bool(details.get("validToken"))
        result: dict = {
            "valid_token": valid,
            "http_status": body.status_code,
            "token_kind": self._token_kind,
        }
        if not valid:
            result["error"] = _extract_error(body)
            return result
        token_info = details.get("token") or {}
        result["scopes"] = token_info.get("scopes") or []
        result["device_name"] = token_info.get("deviceName")
        # Scope validity is not enough: a token may see zero properties.
        try:
            properties = (
                await self._get("/properties", {"pageSize": 5})
            ).get("data", [])
            result["visible_properties"] = len(properties)
        except Beds24Error as exc:
            result["properties_error"] = str(exc)
        try:
            today = datetime.now(UTC).date()
            bookings = (
                await self._get(
                    "/bookings",
                    {
                        "arrivalFrom": (today - timedelta(days=365)).isoformat(),
                        "arrivalTo": (today + timedelta(days=365)).isoformat(),
                        "pageSize": 5,
                    },
                )
            ).get("data", [])
            result["visible_bookings"] = len(bookings)
        except Beds24Error as exc:
            result["bookings_error"] = str(exc)
        return result

    async def fetch_bookings(self) -> list[BookingData]:
        """Upcoming and current bookings within the next year.

        The API returns only upcoming bookings by default; arrivalFrom widens
        the window to also cover bookings that are currently staying.
        """
        today = datetime.now(UTC).date()
        data = (
            await self._get(
                "/bookings",
                {
                    "arrivalFrom": (today - timedelta(days=7)).isoformat(),
                    "arrivalTo": (today + timedelta(days=365)).isoformat(),
                    "pageSize": 200,
                },
            )
        ).get("data", [])
        bookings = []
        for raw in data:
            booking = booking_from_api(raw)
            if booking is not None:
                bookings.append(booking)
        return bookings

    async def fetch_booking(self, beds24_id: str) -> BookingData | None:
        data = (await self._get("/bookings", {"id": beds24_id})).get("data", [])
        if not data:
            return None
        return booking_from_api(data[0])

    async def fetch_property_names(self) -> dict[int, str]:
        data = (await self._get("/properties", {"pageSize": 100})).get("data", [])
        return {
            raw["id"]: raw.get("name") or f"Property {raw['id']}"
            for raw in data
            if raw.get("id") is not None
        }


def get_beds24_adapter() -> MockBeds24 | RealBeds24:
    settings = get_settings()
    if settings.use_mocks or not (settings.beds24_api_key or settings.beds24_refresh_token):
        logger.info("Beds24: using mock adapter")
        return MockBeds24()
    return RealBeds24(
        api_key=settings.beds24_api_key,
        refresh_token=settings.beds24_refresh_token,
        token_kind=settings.beds24_token_kind,
    )
