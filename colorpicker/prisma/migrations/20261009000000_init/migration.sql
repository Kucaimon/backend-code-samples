-- Initial schema for ColorPicker API v0.4 plus the client-approved Lifetime plan.
CREATE TYPE "AuthProvider" AS ENUM ('PASSWORD', 'GOOGLE', 'FACEBOOK', 'APPLE');
CREATE TYPE "CatalogTier" AS ENUM ('FREE', 'PREMIUM');
CREATE TYPE "BillingProvider" AS ENUM ('CREEM', 'YOOKASSA');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE "PlanInterval" AS ENUM ('WEEK', 'MONTH', 'YEAR', 'LIFETIME');
CREATE TYPE "EmailTokenType" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELED', 'FAILED', 'REFUNDED');
CREATE TYPE "PaymentPurpose" AS ENUM ('CHECKOUT', 'RENEWAL', 'RETRY');

CREATE TABLE "User" (
  "id" UUID NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "locale" VARCHAR(12) NOT NULL DEFAULT 'en',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

CREATE TABLE "AuthIdentity" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "AuthProvider" NOT NULL,
  "providerUserId" VARCHAR(255),
  "passwordHash" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthIdentity_userId_provider_key" ON "AuthIdentity"("userId", "provider");
CREATE UNIQUE INDEX "AuthIdentity_provider_providerUserId_key" ON "AuthIdentity"("provider", "providerUserId");
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

CREATE TABLE "Palette" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "name" VARCHAR(60) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Palette_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Palette_userId_updatedAt_idx" ON "Palette"("userId", "updatedAt" DESC);

CREATE TABLE "ColorItem" (
  "id" UUID NOT NULL,
  "paletteId" UUID NOT NULL,
  "name" VARCHAR(40) NOT NULL DEFAULT '',
  "hex" VARCHAR(7) NOT NULL,
  "alpha" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "position" INTEGER NOT NULL,
  "sourceCatalogId" VARCHAR(100),
  "sourceCode" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ColorItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ColorItem_paletteId_position_key" ON "ColorItem"("paletteId", "position");
CREATE INDEX "ColorItem_paletteId_idx" ON "ColorItem"("paletteId");
CREATE INDEX "ColorItem_sourceCatalogId_sourceCode_idx" ON "ColorItem"("sourceCatalogId", "sourceCode");

CREATE TABLE "SavedColor" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "hex" VARCHAR(7) NOT NULL,
  "alpha" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "name" VARCHAR(40) NOT NULL DEFAULT '',
  "sourceCatalogId" VARCHAR(100),
  "sourceCode" VARCHAR(100),
  "dedupeKey" VARCHAR(512) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedColor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedColor_userId_dedupeKey_key" ON "SavedColor"("userId", "dedupeKey");
CREATE INDEX "SavedColor_userId_createdAt_idx" ON "SavedColor"("userId", "createdAt" DESC);

CREATE TABLE "Catalog" (
  "id" VARCHAR(100) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "manufacturer" VARCHAR(200) NOT NULL,
  "tier" "CatalogTier" NOT NULL DEFAULT 'FREE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "contentHash" VARCHAR(64),
  CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogColor" (
  "catalogId" VARCHAR(100) NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "names" JSONB NOT NULL,
  "hex" VARCHAR(7) NOT NULL,
  "labL" DOUBLE PRECISION NOT NULL,
  "labA" DOUBLE PRECISION NOT NULL,
  "labB" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "CatalogColor_pkey" PRIMARY KEY ("catalogId", "code")
);
CREATE INDEX "CatalogColor_catalogId_hex_idx" ON "CatalogColor"("catalogId", "hex");

CREATE TABLE "Plan" (
  "id" VARCHAR(100) NOT NULL,
  "names" JSONB NOT NULL,
  "features" JSONB NOT NULL,
  "interval" "PlanInterval" NOT NULL,
  "trialDays" INTEGER NOT NULL DEFAULT 0,
  "priceUsd" INTEGER NOT NULL,
  "priceRub" INTEGER,
  "creemProductId" VARCHAR(255),
  "isRecurring" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "planId" VARCHAR(100) NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "trialEnd" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "providerRef" VARCHAR(255),
  "providerCustomerRef" VARCHAR(255),
  "autoRenewConsentAt" TIMESTAMP(3),
  "autoRenewConsentText" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "trialReminderSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE INDEX "Subscription_provider_status_currentPeriodEnd_idx" ON "Subscription"("provider", "status", "currentPeriodEnd");
CREATE INDEX "Subscription_providerRef_idx" ON "Subscription"("providerRef");

CREATE TABLE "RefreshToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken"("userId", "expiresAt");

CREATE TABLE "EmailActionToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "type" "EmailTokenType" NOT NULL,
  "tokenHash" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailActionToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailActionToken_tokenHash_key" ON "EmailActionToken"("tokenHash");
CREATE INDEX "EmailActionToken_userId_type_expiresAt_idx" ON "EmailActionToken"("userId", "type", "expiresAt");

CREATE TABLE "Payment" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "subscriptionId" UUID,
  "planId" VARCHAR(100) NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "providerPaymentId" VARCHAR(255),
  "providerOrderRef" VARCHAR(255),
  "providerTransactionRef" VARCHAR(255),
  "checkoutUrl" VARCHAR(2048),
  "providerCustomerRef" VARCHAR(255),
  "amount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "purpose" "PaymentPurpose" NOT NULL DEFAULT 'CHECKOUT',
  "autoRenewConsentAt" TIMESTAMP(3),
  "autoRenewConsentText" TEXT,
  "idempotencyKey" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");
CREATE UNIQUE INDEX "Payment_provider_providerOrderRef_key" ON "Payment"("provider", "providerOrderRef");
CREATE UNIQUE INDEX "Payment_provider_providerTransactionRef_key" ON "Payment"("provider", "providerTransactionRef");
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt" DESC);
CREATE INDEX "Payment_provider_status_idx" ON "Payment"("provider", "status");

CREATE TABLE "OAuthAttempt" (
  "id" UUID NOT NULL,
  "provider" "AuthProvider" NOT NULL,
  "stateHash" VARCHAR(255) NOT NULL,
  "codeVerifier" VARCHAR(255) NOT NULL,
  "nonce" VARCHAR(255) NOT NULL,
  "redirectTo" VARCHAR(512) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OAuthAttempt_stateHash_key" ON "OAuthAttempt"("stateHash");
CREATE INDEX "OAuthAttempt_provider_expiresAt_idx" ON "OAuthAttempt"("provider", "expiresAt");

CREATE TABLE "PaymentEvent" (
  "id" UUID NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "providerEventId" VARCHAR(255) NOT NULL,
  "eventType" VARCHAR(255) NOT NULL,
  "rawPayload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "processingAt" TIMESTAMP(3),
  "processingError" TEXT,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");
CREATE INDEX "PaymentEvent_processedAt_receivedAt_idx" ON "PaymentEvent"("processedAt", "receivedAt");

ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Palette" ADD CONSTRAINT "Palette_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ColorItem" ADD CONSTRAINT "ColorItem_paletteId_fkey" FOREIGN KEY ("paletteId") REFERENCES "Palette"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedColor" ADD CONSTRAINT "SavedColor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogColor" ADD CONSTRAINT "CatalogColor_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailActionToken" ADD CONSTRAINT "EmailActionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
