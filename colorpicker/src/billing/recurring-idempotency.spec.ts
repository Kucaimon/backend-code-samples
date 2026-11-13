import { recurringChargeIdempotencyKey, YOOKASSA_IDEMPOTENCE_KEY_MAX_LENGTH } from './recurring-idempotency';

describe('recurring charge idempotency keys', () => {
  it('fits YooKassa\'s 64-character Idempotence-Key limit for a UUID subscription', () => {
    const subscriptionId = '8766d36f-34e8-4e81-b90c-255e7a381931';
    const period = '2026-10-19T04:33:18.445Z';
    expect(recurringChargeIdempotencyKey(subscriptionId, period, 'RENEWAL', 0).length).toBeLessThanOrEqual(YOOKASSA_IDEMPOTENCE_KEY_MAX_LENGTH);
    expect(recurringChargeIdempotencyKey(subscriptionId, period, 'RETRY', 999_999).length).toBeLessThanOrEqual(YOOKASSA_IDEMPOTENCE_KEY_MAX_LENGTH);
  });

  it('uses a new key for each billing period', () => {
    expect(recurringChargeIdempotencyKey('sub-1', '2026-10-09T00:00:00.000Z', 'RENEWAL', 0))
      .not.toBe(recurringChargeIdempotencyKey('sub-1', '2026-10-16T00:00:00.000Z', 'RENEWAL', 0));
  });

  it('reuses the key when a renewal request is retried after a transient API error', () => {
    expect(recurringChargeIdempotencyKey('sub-1', '2026-10-09T00:00:00.000Z', 'RENEWAL', 0))
      .toBe(recurringChargeIdempotencyKey('sub-1', '2026-10-09T00:00:00.000Z', 'RENEWAL', 0));
  });

  it('uses a new key for each scheduled retry attempt', () => {
    const period = '2026-10-09T00:00:00.000Z';
    expect(recurringChargeIdempotencyKey('sub-1', period, 'RETRY', 1))
      .not.toBe(recurringChargeIdempotencyKey('sub-1', period, 'RETRY', 2));
  });

  it('keeps one renewal and the retry attempts in different idempotency namespaces', () => {
    const period = '2026-10-09T00:00:00.000Z';
    expect(recurringChargeIdempotencyKey('sub-1', period, 'RENEWAL', 0))
      .not.toBe(recurringChargeIdempotencyKey('sub-1', period, 'RETRY', 1));
  });
});
