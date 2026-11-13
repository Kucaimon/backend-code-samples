# Ananda backend sample — Python / FastAPI / SQLAlchemy

Отдельная подборка исходников из concierge-mvp. В архив не включены `.env`, локальная БД, виртуальное окружение, логи, runtime-файлы, ключи и клиентские медиафайлы.

## Файлы

- `app/db.py` — асинхронный SQLAlchemy engine и session factory.
- `app/models.py` — ORM-модели гостей, бронирований, диалогов и служебных сущностей.
- `app/services/ingest.py` — обработка данных бронирования, поиск/сопоставление гостя и upsert записи.
- `app/adapters/beds24.py` — асинхронный HTTP-клиент и адаптер Beds24 API v2.
- `app/adapters/base.py` — типизированная структура данных бронирования.
- `app/core/guests.py` — логика получения и создания записи гостя.
- `app/core/telemetry.py` — запись событий приложения.
- `tests/` — тесты адаптера Beds24, core-логики и smoke-проверки.

Это отдельный пример на Python, не NestJS. В зависимостях проекта присутствуют FastAPI, SQLAlchemy asyncio и asyncpg.
