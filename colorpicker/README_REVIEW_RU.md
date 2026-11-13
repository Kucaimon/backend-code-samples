# Backend code sample — NestJS / TypeScript / PostgreSQL

Подборка исходников backend API из проекта Colorpicker. В архив включены исходные файлы приложения, тесты, Prisma schema и SQL-миграции. Файлы `.env`, ключи, токены, данные БД и локальные runtime-данные не включены.

## Что посмотреть

- `src/main.ts`, `src/app.module.ts` — bootstrap и сборка модулей NestJS.
- `src/auth/auth.service.ts` — регистрация, авторизация, хеширование паролей, access/refresh tokens, ротация refresh-токенов и обработка повторного использования.
- `src/auth/*.spec.ts` — тесты auth-сценариев, в том числе повторного использования уже ротированного refresh-токена.
- `src/billing/billing.service.ts` — бизнес-логика платежей и подписок, checkout, recurring payments, обработка статусов провайдеров и согласованности операций с БД.
- `src/billing/webhooks.controller.ts` — HTTP endpoints для webhook-событий платёжных провайдеров.
- `src/billing/payment-method.ts` — проверка и нормализация данных сохранённой карты, формирование безопасного публичного представления.
- `src/billing/recurring-idempotency.ts` и тест — ключи идемпотентности для повторных и плановых списаний.
- `src/billing/*policy*` и соответствующие тесты — отдельные функции бизнес-правил подписок и доступа.
- `src/prisma/prisma.service.ts` — подключение и отключение Prisma Client в жизненном цикле NestJS.
- `prisma/schema.prisma` — схема PostgreSQL: модели, связи, enum-типы и индексы.
- `prisma/migrations/` — SQL-миграции схемы.

## Запуск тестов

Зависимости зафиксированы в `package-lock.json`. После установки зависимостей можно запустить unit-тесты командой:

```bash
npm ci
npx prisma generate
npm test -- --runInBand
```

Для DB/e2e-тестов требуется отдельная тестовая PostgreSQL-база и переменные окружения; реальные production credentials в этой подборке отсутствуют.
