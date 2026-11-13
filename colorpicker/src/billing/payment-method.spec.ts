import { getStoredSavedBankCard, hasSavedPaymentMethod, parseSavedYooKassaBankCard, parseSavedYooKassaPaymentMethodId, resolveRenewalPaymentMethod, toPublicPaymentMethod } from './payment-method';

describe('YooKassa saved payment method details', () => {
  const bankCard = {
    id: 'provider-private-payment-method-id',
    saved: true,
    type: 'bank_card',
    card: { card_type: 'Visa', last4: '4444', expiry_month: '3', expiry_year: '2030' },
  };

  it('normalizes a saved bank card for storage without exposing its provider ID publicly', () => {
    const parsed = parseSavedYooKassaBankCard(bankCard);
    expect(parsed).toEqual({
      id: 'provider-private-payment-method-id',
      paymentMethodType: 'bank_card',
      paymentMethodCardType: 'Visa',
      paymentMethodLast4: '4444',
      paymentMethodExpiryMonth: '03',
      paymentMethodExpiryYear: '2030',
    });

    expect(toPublicPaymentMethod({ provider: 'YOOKASSA', providerRef: parsed!.id, ...parsed! })).toEqual({
      type: 'bank_card', cardType: 'Visa', last4: '4444', expiryMonth: '03', expiryYear: '2030',
    });
    expect(JSON.stringify(toPublicPaymentMethod({ provider: 'YOOKASSA', providerRef: parsed!.id, ...parsed! })))
      .not.toContain('provider-private-payment-method-id');
  });

  it.each([
    ['not saved', { ...bankCard, saved: false }],
    ['not a bank card', { ...bankCard, type: 'yoo_money' }],
    ['missing card details', { ...bankCard, card: undefined }],
    ['invalid last four digits', { ...bankCard, card: { ...bankCard.card, last4: '44x4' } }],
    ['invalid expiry month', { ...bankCard, card: { ...bankCard.card, expiry_month: '13' } }],
  ])('rejects a payment method that is %s', (_reason, method) => {
    expect(parseSavedYooKassaBankCard(method)).toBeNull();
  });

  it('keeps provider token detection separate from optional display metadata', () => {
    const incomplete = { id: 'new-provider-token', saved: true, type: 'bank_card' };
    expect(parseSavedYooKassaPaymentMethodId(incomplete)).toBe('new-provider-token');
    expect(parseSavedYooKassaBankCard(incomplete)).toBeNull();
    expect(parseSavedYooKassaPaymentMethodId({ ...incomplete, saved: false })).toBeNull();
    expect(parseSavedYooKassaPaymentMethodId({ ...incomplete, type: 'yoo_money' })).toBeNull();
  });

  it('distinguishes a stored token from unavailable display metadata', () => {
    const legacy = { provider: 'YOOKASSA', providerRef: bankCard.id, paymentMethodType: null, paymentMethodCardType: null, paymentMethodLast4: null, paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null };
    expect(hasSavedPaymentMethod(legacy)).toBe(true);
    expect(toPublicPaymentMethod(legacy)).toBeNull();
    expect(hasSavedPaymentMethod({ ...legacy, providerRef: null })).toBe(false);
  });


  it('preserves a legacy saved token when a renewal response omits payment_method', () => {
    const legacy = {
      provider: 'YOOKASSA', providerRef: bankCard.id, paymentMethodType: null,
      paymentMethodCardType: null, paymentMethodLast4: null,
      paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    };
    expect(resolveRenewalPaymentMethod(legacy, undefined)).toEqual({
      providerRef: bankCard.id, paymentMethodType: null, paymentMethodCardType: null,
      paymentMethodLast4: null, paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    });
  });

  it('preserves the same legacy token when a renewal returns matching ID but incomplete metadata', () => {
    const legacy = {
      provider: 'YOOKASSA', providerRef: bankCard.id, paymentMethodType: null,
      paymentMethodCardType: null, paymentMethodLast4: null,
      paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    };
    expect(resolveRenewalPaymentMethod(legacy, { id: bankCard.id, saved: true, type: 'bank_card' })).toEqual({
      providerRef: bankCard.id, paymentMethodType: null, paymentMethodCardType: null,
      paymentMethodLast4: null, paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    });
  });

  it('stores a newly confirmed token even when display metadata is missing', () => {
    const legacy = {
      provider: 'YOOKASSA', providerRef: bankCard.id, paymentMethodType: 'bank_card',
      paymentMethodCardType: 'Visa', paymentMethodLast4: '4444',
      paymentMethodExpiryMonth: '03', paymentMethodExpiryYear: '2030',
    };
    expect(resolveRenewalPaymentMethod(legacy, { id: 'new-provider-token', saved: true, type: 'bank_card' })).toEqual({
      providerRef: 'new-provider-token', paymentMethodType: null, paymentMethodCardType: null,
      paymentMethodLast4: null, paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    });
  });

  it('does not retain an old token when the renewal response explicitly returns another method', () => {
    const legacy = {
      provider: 'YOOKASSA', providerRef: bankCard.id, paymentMethodType: null,
      paymentMethodCardType: null, paymentMethodLast4: null,
      paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    };
    expect(resolveRenewalPaymentMethod(legacy, { id: 'different-id', type: 'bank_card' })).toEqual({
      providerRef: null, paymentMethodType: null, paymentMethodCardType: null,
      paymentMethodLast4: null, paymentMethodExpiryMonth: null, paymentMethodExpiryYear: null,
    });
    expect(resolveRenewalPaymentMethod(legacy, { id: bankCard.id, type: 'yoo_money' })).toMatchObject({ providerRef: null });
    expect(resolveRenewalPaymentMethod(legacy, { id: bankCard.id, type: 'bank_card', saved: false })).toMatchObject({ providerRef: null });
  });

  it('does not expose Creem, detached or incomplete payment methods', () => {
    const validStored = {
      provider: 'YOOKASSA', providerRef: bankCard.id,
      paymentMethodType: 'bank_card', paymentMethodCardType: 'Visa', paymentMethodLast4: '4444',
      paymentMethodExpiryMonth: '12', paymentMethodExpiryYear: '2030',
    };
    expect(toPublicPaymentMethod({ ...validStored, provider: 'CREEM' })).toBeNull();
    expect(toPublicPaymentMethod({ ...validStored, providerRef: null })).toBeNull();
    expect(toPublicPaymentMethod({ ...validStored, paymentMethodLast4: null })).toBeNull();
    expect(getStoredSavedBankCard({ ...validStored, paymentMethodCardType: null })).toBeNull();
  });
});
