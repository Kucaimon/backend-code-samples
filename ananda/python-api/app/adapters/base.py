"""Protocols and DTOs shared by all adapters.

The rest of the application depends only on these contracts, so switching
between mock and real implementations never touches business logic.
"""
from dataclasses import dataclass
from datetime import date
from typing import Protocol


@dataclass
class BookingData:
    beds24_id: str
    guest_name: str | None = None
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    language: str = ""
    check_in: date | None = None
    check_out: date | None = None
    object_name: str | None = None
    property_id: int | None = None
    status: str = "active"


class Beds24Adapter(Protocol):
    async def fetch_bookings(self) -> list[BookingData]: ...

    async def fetch_booking(self, beds24_id: str) -> BookingData | None: ...


class WazzupAdapter(Protocol):
    async def send_message(self, chat_id: str, text: str) -> None: ...


class LLMAdapter(Protocol):
    async def complete(self, system: str, user: str) -> str: ...
