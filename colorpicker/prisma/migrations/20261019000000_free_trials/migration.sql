-- Per-feature free trials: one row per user and feature, created by the first
-- POST /me/free-trials/{feature}. The trial length (FREE_TRIAL_SECONDS) is not stored.
CREATE TYPE "FreeTrialFeature" AS ENUM ('GALLERY', 'CAMERA', 'CONVERTER', 'CATALOGS');

CREATE TABLE "FreeTrial" (
    "userId" UUID NOT NULL,
    "feature" "FreeTrialFeature" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeTrial_pkey" PRIMARY KEY ("userId","feature")
);

ALTER TABLE "FreeTrial" ADD CONSTRAINT "FreeTrial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
