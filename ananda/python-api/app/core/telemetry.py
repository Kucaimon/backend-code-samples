"""Telemetry: structured events + export to a text document (agreement p. 2.1.1)."""
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import TelemetryEvent


async def log_event(session: AsyncSession, event_type: str, payload: dict | None = None) -> None:
    session.add(TelemetryEvent(event_type=event_type, payload=payload or {}))
    await session.commit()


async def export_events_to_text(session: AsyncSession, limit: int = 10_000) -> Path:
    """Dump telemetry events to a text file; returns the file path."""
    settings = get_settings()
    result = await session.execute(
        select(TelemetryEvent).order_by(TelemetryEvent.id.desc()).limit(limit)
    )
    events = list(result.scalars())

    settings.telemetry_export_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    path = settings.telemetry_export_dir / f"telemetry_{stamp}.txt"

    lines = [
        f"{event.created_at.isoformat()}\t{event.event_type}\t{event.payload}"
        for event in reversed(events)
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
