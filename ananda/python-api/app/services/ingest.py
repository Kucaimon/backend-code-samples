"""Booking ingest: single point of truth for webhook payloads and sync.

Flow per booking payload (agreement p. 2.1.1):
  * map payload fields -> BookingData
  * upsert Booking by beds24_id
  * match the guest by phone/mobile (agreement: link by booking number or phone)
  * write telemetry (booking_created / booking_updated)
"""
import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import BookingData
from app.core.telemetry import log_event
from app.models import Booking, Guest

logger = logging.getLogger(__name__)


def normalize_phone(phone: str | None) -> str | None:
    """Keep digits only; matching happens on the last 10 digits."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    return digits or None


def phones_match(a: str | None, b: str | None) -> bool:
    a, b = normalize_phone(a), normalize_phone(b)
    if not a or not b:
        return False
    return a == b or a[-10:] == b[-10:]


async def _find_guest_by_phone(session: AsyncSession, phone: str | None) -> Guest | None:
    normalized = normalize_phone(phone)
    if not normalized:
        return None
    result = await session.execute(select(Guest))
    for guest in result.scalars():
        if phones_match(guest.phone, normalized):
            return guest
    return None


async def upsert_booking(session: AsyncSession, data: BookingData) -> Booking:
    booking = await session.scalar(select(Booking).where(Booking.beds24_id == data.beds24_id))
    created = booking is None

    guest = await _find_guest_by_phone(session, data.phone) or await _find_guest_by_phone(
        session, data.mobile
    )
    if guest is None and (data.guest_name or data.phone or data.mobile):
        guest = Guest(
            name=data.guest_name,
            phone=normalize_phone(data.phone or data.mobile),
            language=data.language or "ru",
        )
        session.add(guest)
        await session.flush()
    elif guest is not None:
        changed = False
        if data.guest_name and not guest.name:
            guest.name = data.guest_name
            changed = True
        if data.language and guest.language == "ru" and data.language != "ru":
            guest.language = data.language
            changed = True
        if changed:
            await session.flush()

    if booking is None:
        booking = Booking(beds24_id=data.beds24_id)
        session.add(booking)

    changes: dict = {}

    def apply(field: str, value) -> None:
        if value is not None and getattr(booking, field) != value:
            changes[field] = value
            setattr(booking, field, value)

    apply("guest_id", guest.id if guest else booking.guest_id)
    apply("object_name", data.object_name)
    apply("check_in", data.check_in)
    apply("check_out", data.check_out)
    apply("status", data.status)

    await session.commit()

    if created:
        await log_event(
            session,
            "booking_created",
            {"beds24_id": data.beds24_id, "guest_id": booking.guest_id},
        )
    elif changes:
        await log_event(
            session, "booking_updated", {"beds24_id": data.beds24_id, "changes": list(changes)}
        )
    return booking
