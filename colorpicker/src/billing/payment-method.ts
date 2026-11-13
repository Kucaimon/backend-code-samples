/**
 * Minimal, non-sensitive details for the saved YooKassa bank card.
 * Never expose the provider's payment_method.id to the frontend.
 */
export interface YooKassaPaymentMethod {
  id?: string;
  saved?: boolean;
  type?: string;
  card?: {
    card_type?: string;
    last4?: string;
    expiry_month?: string | number;
    expiry_year?: string | number;
  };
}

export interface StoredPaymentMethodFields {
  paymentMethodType: string | null;
  paymentMethodCardType: string | null;
  paymentMethodLast4: string | null;
  paymentMethodExpiryMonth: string | null;
  paymentMethodExpiryYear: string | null;
}

export interface SavedBankCard extends StoredPaymentMethodFields {
  id: string;
  paymentMethodType: 'bank_card';
  paymentMethodCardType: string;
  paymentMethodLast4: string;
  paymentMethodExpiryMonth: string;
  paymentMethodExpiryYear: string;
}

export interface PublicPaymentMethod {
  type: 'bank_card';
  cardType: string;
  last4: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface SubscriptionPaymentMethodSource extends StoredPaymentMethodFields {
  provider: string;
  providerRef: string | null;
}

/** Return a provider token only when YooKassa explicitly marks a bank card as saved. */
export function parseSavedYooKassaPaymentMethodId(method: YooKassaPaymentMethod | null | undefined): string | null {
  if (method?.saved !== true || method.type !== 'bank_card' || typeof method.id !== 'string' || !method.id.trim()) {
    return null;
  }
  return method.id;
}

/** Accept only a saved bank card with enough metadata to display it and offer unlinking in the UI. */
export function parseSavedYooKassaBankCard(method: YooKassaPaymentMethod | null | undefined): SavedBankCard | null {
  if (method?.saved !== true || typeof method.id !== 'string' || !method.id.trim() || method.type !== 'bank_card') {
    return null;
  }

  const card = method.card;
  const cardType = typeof card?.card_type === 'string' ? card.card_type.trim().slice(0, 40) : '';
  const last4 = typeof card?.last4 === 'string' ? card.last4.trim() : '';
  const rawMonth = card?.expiry_month;
  const monthDigits = typeof rawMonth === 'number' || typeof rawMonth === 'string' ? String(rawMonth).trim() : '';
  const expiryMonth = /^\d{1,2}$/.test(monthDigits) ? monthDigits.padStart(2, '0') : '';
  const rawYear = card?.expiry_year;
  const expiryYear = typeof rawYear === 'number' || typeof rawYear === 'string' ? String(rawYear).trim() : '';

  if (
    !cardType
    || !/^\d{4}$/.test(last4)
    || !/^(0[1-9]|1[0-2])$/.test(expiryMonth)
    || !/^\d{4}$/.test(expiryYear)
  ) {
    return null;
  }

  return {
    id: method.id,
    paymentMethodType: 'bank_card',
    paymentMethodCardType: cardType,
    paymentMethodLast4: last4,
    paymentMethodExpiryMonth: expiryMonth,
    paymentMethodExpiryYear: expiryYear,
  };
}

/** Shape returned by GET /me and the billing mutation endpoints. */
export function hasSavedPaymentMethod(subscription: SubscriptionPaymentMethodSource): boolean {
  return subscription.provider === 'YOOKASSA' && typeof subscription.providerRef === 'string' && subscription.providerRef.length > 0;
}

export function toPublicPaymentMethod(subscription: SubscriptionPaymentMethodSource): PublicPaymentMethod | null {
  if (subscription.provider !== 'YOOKASSA' || !subscription.providerRef || subscription.paymentMethodType !== 'bank_card') {
    return null;
  }

  const cardType = subscription.paymentMethodCardType;
  const last4 = subscription.paymentMethodLast4;
  const expiryMonth = subscription.paymentMethodExpiryMonth;
  const expiryYear = subscription.paymentMethodExpiryYear;
  if (
    !cardType
    || !last4
    || !expiryMonth
    || !expiryYear
    || !/^\d{4}$/.test(last4)
    || !/^(0[1-9]|1[0-2])$/.test(expiryMonth)
    || !/^\d{4}$/.test(expiryYear)
  ) {
    return null;
  }

  return { type: 'bank_card', cardType, last4, expiryMonth, expiryYear };
}

/** Rebuild validated stored details during renewal if YooKassa omits card metadata in the webhook. */
export function getStoredSavedBankCard(subscription: SubscriptionPaymentMethodSource): SavedBankCard | null {
  const publicCard = toPublicPaymentMethod(subscription);
  if (!publicCard || !subscription.providerRef) return null;
  return {
    id: subscription.providerRef,
    paymentMethodType: 'bank_card',
    paymentMethodCardType: publicCard.cardType,
    paymentMethodLast4: publicCard.last4,
    paymentMethodExpiryMonth: publicCard.expiryMonth,
    paymentMethodExpiryYear: publicCard.expiryYear,
  };
}

export interface RenewalPaymentMethodState extends StoredPaymentMethodFields {
  providerRef: string | null;
}

/**
 * Resolve the saved method after a successful recurring charge. A renewal was
 * initiated using the existing providerRef, so an omitted payment_method in
 * the provider response is not evidence that the token disappeared. Preserve
 * the token (and any existing display metadata) when the response omits the
 * object or confirms the same bank-card ID. An explicit different/non-card
 * method must not inherit the old token.
 */
export function resolveRenewalPaymentMethod(
  subscription: SubscriptionPaymentMethodSource,
  returnedMethod: YooKassaPaymentMethod | null | undefined,
): RenewalPaymentMethodState {
  const returnedMethodId = parseSavedYooKassaPaymentMethodId(returnedMethod);
  const returnedCard = parseSavedYooKassaBankCard(returnedMethod);
  if (returnedMethodId) {
    if (returnedCard) {
      return {
        providerRef: returnedCard.id,
        paymentMethodType: returnedCard.paymentMethodType,
        paymentMethodCardType: returnedCard.paymentMethodCardType,
        paymentMethodLast4: returnedCard.paymentMethodLast4,
        paymentMethodExpiryMonth: returnedCard.paymentMethodExpiryMonth,
        paymentMethodExpiryYear: returnedCard.paymentMethodExpiryYear,
      };
    }

    // Keep display data only when it belongs to this exact existing token.
    if (hasSavedPaymentMethod(subscription) && subscription.providerRef === returnedMethodId) {
      return {
        providerRef: returnedMethodId,
        paymentMethodType: subscription.paymentMethodType,
        paymentMethodCardType: subscription.paymentMethodCardType,
        paymentMethodLast4: subscription.paymentMethodLast4,
        paymentMethodExpiryMonth: subscription.paymentMethodExpiryMonth,
        paymentMethodExpiryYear: subscription.paymentMethodExpiryYear,
      };
    }

    // The provider confirmed a saved token, but no usable card metadata was supplied.
    return {
      providerRef: returnedMethodId,
      paymentMethodType: null,
      paymentMethodCardType: null,
      paymentMethodLast4: null,
      paymentMethodExpiryMonth: null,
      paymentMethodExpiryYear: null,
    };
  }

  const existingMethodId = hasSavedPaymentMethod(subscription) ? subscription.providerRef : null;
  const mayRetainExisting = Boolean(existingMethodId && (
    !returnedMethod
    || (returnedMethod.type === 'bank_card' && returnedMethod.id === existingMethodId && returnedMethod.saved !== false)
  ));
  if (mayRetainExisting && existingMethodId) {
    return {
      providerRef: existingMethodId,
      paymentMethodType: subscription.paymentMethodType,
      paymentMethodCardType: subscription.paymentMethodCardType,
      paymentMethodLast4: subscription.paymentMethodLast4,
      paymentMethodExpiryMonth: subscription.paymentMethodExpiryMonth,
      paymentMethodExpiryYear: subscription.paymentMethodExpiryYear,
    };
  }

  return {
    providerRef: null,
    paymentMethodType: null,
    paymentMethodCardType: null,
    paymentMethodLast4: null,
    paymentMethodExpiryMonth: null,
    paymentMethodExpiryYear: null,
  };
}
