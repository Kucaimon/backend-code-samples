"""Sanitized code excerpt from Ananda's Telegram staff bot.

The callback handler is taken from the test-project patch dated 2026-10-19.
Guest-facing message copy has been generalized; the control flow and application
calls are retained from the source excerpt. This file is for code review only,
not a standalone runnable module (application imports/models are omitted).
"""

# The complete application provides aiogram, SQLAlchemy, SessionFactory,
# models, manager lookup, notification queue, telemetry and property profile.

@dp.callback_query(F.data.startswith("early:decision:"))
async def cb_early_checkin_decision(callback: CallbackQuery) -> None:
    parts = (callback.data or "").split(":")
    if len(parts) != 4 or parts[2] not in {"confirm", "reject"}:
        await callback.answer("Неизвестное действие", show_alert=True)
        return
    action = parts[2]
    try:
        notification_id = int(parts[3])
    except ValueError:
        await callback.answer("Некорректный запрос", show_alert=True)
        return
    try:
        async with SessionFactory() as session:
            manager = await get_active_manager(session, callback.from_user.id)
            if manager is None:
                await callback.answer("Нет доступа к заявкам", show_alert=True)
                return
            notification_result = await session.execute(
                select(Notification).where(Notification.id == notification_id).with_for_update()
            )
            notification = notification_result.scalar_one_or_none()
            if notification is None or notification.target_type != "manager":
                await callback.answer("Запрос не найден", show_alert=True)
                return
            payload = dict(notification.payload or {})
            if payload.get("kind") != "early_checkin":
                await callback.answer("Это не запрос раннего заезда", show_alert=True)
                return
            if payload.get("decision"):
                await callback.answer("Решение уже принято", show_alert=True)
                return
            guest_id = payload.get("guest_id")
            guest = await session.get(Guest, int(guest_id)) if guest_id else None
            if guest is None or not guest.telegram_id:
                await callback.answer("У гостя нет активного Telegram чата", show_alert=True)
                return
            booking_id = payload.get("booking_id")
            booking = await session.get(Booking, int(booking_id)) if booking_id else None
            chat = await session.scalar(
                select(ChatSession).where(ChatSession.guest_id == guest.id).with_for_update()
            )
            chat_context = dict(chat.context or {}) if chat is not None else {}
            requested_time = str(payload.get("requested_time") or payload.get("time") or "—")
            if chat is None or not chat_context.get("early_checkin_decision_pending"):
                await callback.answer("Запрос уже неактуален", show_alert=True)
                return
            if str(chat_context.get("early_checkin_time") or "") != requested_time:
                await callback.answer("Время в запросе изменилось. Создайте запрос заново.", show_alert=True)
                return
            profile = get_property_profile()
            if action == "confirm":
                response = (
                    f"Ранний заезд в {requested_time} подтверждён."
                    if guest.language == "ru"
                    else f"Early check-in at {requested_time} is confirmed."
                )
                decision_label = "подтвердил" if guest.language == "ru" else "approved"
            else:
                response = (
                    f"Ранний заезд недоступен. Стандартное время заселения: {profile.check_in_time}."
                    if guest.language == "ru"
                    else f"Early check-in is unavailable. Standard check-in time: {profile.check_in_time}."
                )
                decision_label = "отклонил" if guest.language == "ru" else "rejected"
            decided_at = datetime.now(UTC)
            payload.update({
                "decision": action,
                "decision_by_manager_id": manager.id,
                "decision_by_telegram_id": callback.from_user.id,
                "decision_at": decided_at.isoformat(),
            })
            notification.payload = payload
            chat_context.update({
                "early_checkin_decision_pending": False,
                "early_checkin_decision": action,
                "early_checkin_decided_at": decided_at.isoformat(),
            })
            chat.context = chat_context
            await enqueue_guest_notification(
                session, guest.id, response,
                payload={"kind": "early_checkin_decision", "channel": "telegram",
                         "booking_id": booking.id if booking else None,
                         "requested_time": requested_time, "decision": action},
            )
            await log_event(
                session, "early_checkin_decided",
                {"guest_id": guest.id, "booking_id": booking.id if booking else None,
                 "manager_id": manager.id, "decision": action},
            )
    except (ValueError, TypeError):
        await callback.answer("Некорректные данные запроса", show_alert=True)
        return
    except DB_ERRORS as exc:
        logger.warning("Early check-in decision failed: %s", exc)
        await callback.answer("Ошибка базы данных", show_alert=True)
        return
    if callback.message:
        await callback.message.edit_text(
            f"{callback.message.text or ''}\n\nРешение менеджера: {decision_label}.",
            reply_markup=None,
        )
    await callback.answer("Гостю отправлен ответ" if guest.language == "ru" else "The guest has been notified")

