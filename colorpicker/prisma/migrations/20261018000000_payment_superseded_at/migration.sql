-- A pending checkout that expired (older than 60 minutes) or was replaced by a new checkout.
-- Such a payment is CANCELED locally but may still be paid at the provider; supersededAt lets a
-- provider-confirmed late success be applied instead of silently ignored.
ALTER TABLE "Payment" ADD COLUMN "supersededAt" TIMESTAMP(3);
