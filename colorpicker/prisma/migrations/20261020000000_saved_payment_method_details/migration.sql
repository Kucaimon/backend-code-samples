-- Store only display-safe card metadata. The YooKassa payment_method.id remains in
-- Subscription.providerRef and is never returned by the public API.
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodType" VARCHAR(40);
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodCardType" VARCHAR(40);
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodLast4" VARCHAR(4);
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodExpiryMonth" VARCHAR(2);
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodExpiryYear" VARCHAR(4);
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodRevision" INTEGER NOT NULL DEFAULT 0;
