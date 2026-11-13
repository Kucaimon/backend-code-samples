# Backend code samples

Фрагменты серверной разработки для технического ревью.

## ColorPicker — NestJS / TypeScript / PostgreSQL

Серверная логика веб-приложения с авторизацией, подписками и платёжными интеграциями.

Основные файлы для изучения:
- `src/auth/auth.service.ts` — регистрация, JWT, хеширование паролей, ротация refresh-токенов.
- `src/billing/billing.service.ts` — создание платежей, подписки, повторные списания, интеграции платёжных провайдеров.
- `src/billing/webhooks.controller.ts` — приём платёжных webhook.
- `src/billing/payment-method.ts` — валидация и представление сохранённых способов оплаты.
- `src/billing/recurring-idempotency.ts` — идемпотентность повторных списаний.
- `src/prisma/prisma.service.ts` — жизненный цикл Prisma в NestJS.
- `prisma/schema.prisma` — модели, связи и индексы PostgreSQL.
- `prisma/migrations/` — SQL-миграции.
- `src/**/*.spec.ts` — unit-тесты критичной логики.

## Ananda

Дополнительный пример серверной логики и интеграций; материалы будут добавлены отдельно.

> Репозиторий предназначен для просмотра примеров кода, а не для запуска коммерческих систем.
