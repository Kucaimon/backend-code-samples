"""Guest records: match by channel identity, create on first contact."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationMessage, Guest


async def get_or_create_guest(
    session: AsyncSession,
    *,
    telegram_id: int | None = None,
    language: str = "ru",
) -> Guest:
    guest = None
    if telegram_id is not None:
        result = await session.execute(select(Guest).where(Guest.telegram_id == telegram_id))
        guest = result.scalar_one_or_none()
    if guest is None:
        guest = Guest(telegram_id=telegram_id, language=language)
        session.add(guest)
        await session.commit()
    return guest


async def save_message(
    session: AsyncSession,
    *,
    guest_id: int | None,
    channel: str,
    direction: str,
    text: str,
) -> None:
    session.add(
        ConversationMessage(guest_id=guest_id, channel=channel, direction=direction, text=text)
    )
    await session.commit()
