export type RecurringChargePurpose = 'RENEWAL' | 'RETRY';

/** YooKassa rejects a longer Idempotence-Key with 400 invalid_request. */
export const YOOKASSA_IDEMPOTENCE_KEY_MAX_LENGTH = 64;

/**
 * Keep retries idempotent within one attempt, but give each scheduled retry a
 * distinct key so a failed earlier retry cannot permanently block later tries.
 * The period end is encoded as base-36 milliseconds so the key stays within
 * YooKassa's 64-character limit (51 characters for a renewal).
 */
export function recurringChargeIdempotencyKey(
  subscriptionId: string,
  periodKey: string,
  purpose: RecurringChargePurpose,
  retryCount: number,
): string {
  const periodMs = Date.parse(periodKey);
  const period = Number.isNaN(periodMs) ? periodKey : periodMs.toString(36);
  const attemptKey = purpose === 'RETRY' ? `t${Math.max(1, Math.floor(retryCount))}` : 'r';
  return `rc:${subscriptionId}:${period}:${attemptKey}`;
}
