# Backend code samples — technical review

Подборка фрагментов backend-кода для оценки подходов к разработке, работы с бизнес-логикой, базой данных и внешними API. Это **не полные коммерческие репозитории**.

## ColorPicker — TypeScript / NestJS / PostgreSQL / Prisma

Основной пример, наиболее близкий к требуемому стеку платёжных микросервисов.

- `colorpicker/src/auth/auth.service.ts` — регистрация, авторизация, JWT, refresh-токены и их ротация.
- `colorpicker/src/billing/billing.service.ts` — платежи, подписки, рекуррентные операции и интеграции YooKassa / Creem.
- `colorpicker/src/billing/webhooks.controller.ts` — точки приёма webhook.
- `colorpicker/src/billing/payment-method.ts` — обработка данных сохранённых способов оплаты.
- `colorpicker/src/billing/recurring-idempotency.ts` — ключи идемпотентности для повторных списаний.
- `colorpicker/src/prisma/prisma.service.ts` — интеграция Prisma с NestJS.
- `colorpicker/prisma/schema.prisma`, `colorpicker/prisma/migrations/` — схема PostgreSQL и миграции.
- `colorpicker/src/**/*.spec.ts` — выборочные unit-тесты.

Подробнее: `colorpicker/README_REVIEW_RU.md`. Набор файлов выборочный; запуск всего приложения или всех тестов только по этой подборке не гарантируется.

## Ananda — Python / FastAPI / SQLAlchemy / Beds24

- `ananda/python-api/app/adapters/beds24.py` — асинхронный адаптер внешнего API.
- `ananda/python-api/app/services/ingest.py` — обработка данных бронирования.
- `ananda/python-api/app/models.py`, `app/db.py` — SQLAlchemy модели и сессии.
- `ananda/python-api/tests/` — тесты адаптера и core-логики.

Подробнее: `ananda/python-api/README_REVIEW_RU.md`.

## Ananda — Python / Telegram staff bot

- `ananda/early-checkin/early_checkin_decision_excerpt.py` — фрагмент обработчика решения менеджера, работа с транзакционной логикой, проверками состояния и уведомлениями.
- `ananda/early-checkin/early_checkin_flow_acceptance.py` — статическая проверка сценария из полного проекта; автономно по этой подборке не запускается.

Подробнее: `ananda/early-checkin/README_RU.md`.

## Область применения

Исходные файлы представлены для чтения и code review. В публикацию не включены окружения `.env`, production-ключи, БД и логи. Возможность запуска зависимых модулей ограничена составом подборки. Проекты Ananda приведены именно как Python-примеры, не как NestJS.

**Перед размещением в публичном доступе необходимо подтвердить право распространять фрагменты клиентских проектов и соблюдение NDA.**
