import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingProvider,
  PaymentPurpose,
  PaymentStatus,
  PlanInterval,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIpAllowed } from '../common/network/ip-range';
import { recurringChargeIdempotencyKey } from './recurring-idempotency';
import { grantsPremiumAccess } from './access-policy';
import { hasCheckoutConflict } from './checkout-policy';
import { addBillingInterval } from './period';
import { YOOKASSA_RETRY_GRACE_MS } from './retry-window';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { CheckoutDto } from './dto/checkout.dto';
import { hasSavedPaymentMethod, parseSavedYooKassaBankCard, parseSavedYooKassaPaymentMethodId, resolveRenewalPaymentMethod, toPublicPaymentMethod, type YooKassaPaymentMethod } from './payment-method';

type CheckoutPayment = {
  id: string;
  provider: BillingProvider;
  planId: string;
  checkoutUrl: string | null;
  amount: number;
  currency: string;
  idempotencyKey: string | null;
  autoRenewConsentAt: Date | null;
  autoRenewConsentText: string | null;
};

interface ProviderPayment {
  id?: string;
  status?: string;
  payment_id?: string;
  amount?: { value?: string; currency?: string };
  refunded_amount?: { value?: string; currency?: string };
  metadata?: Record<string, unknown>;
  payment_method?: YooKassaPaymentMethod;
  confirmation?: { confirmation_url?: string };
  customer?: string | { id?: string };
  customer_id?: string;
  subscription?: string | { id?: string; status?: string };
  product?: string | { id?: string; price?: number; currency?: string; billing_type?: string };
  product_id?: string;
  order?: string | { id?: string; product?: string; currency?: string; amount?: number; amount_paid?: number; type?: string; transaction?: string | { id?: string } };
  transaction?: string | { id?: string; status?: string; amount?: number; amount_paid?: number };
  refund_amount?: number;
  refund_currency?: string;
  checkout_url?: string;
  customer_portal_link?: string;
  url?: string;
}

/** A pending checkout older than this is re-checked (YooKassa) or canceled (Creem). */
export const STALE_CHECKOUT_MS = 60 * 60 * 1000;

class ProviderHttpException extends BadGatewayException {
  constructor(readonly providerStatus: number, private readonly createRequest: boolean) {
    super({ code: 'internal', message: 'Payment provider rejected the request' });
  }

  get isDefinitivePaymentRejection(): boolean {
    // A timeout, conflict or rate limit can follow an accepted request; retain
    // the original idempotency key in those cases to avoid a double charge.
    return this.createRequest
      && this.providerStatus >= 400
      && this.providerStatus < 500
      && ![408, 409, 429].includes(this.providerStatus);
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async checkout(userId: string, dto: CheckoutDto) {
    const provider = dto.provider === 'creem' ? BillingProvider.CREEM : BillingProvider.YOOKASSA;
    // Resolve this user's stale attempts first: a stale YooKassa payment that was
    // actually paid becomes a subscription (and then 409 already_subscribed below).
    await this.expireStaleCheckouts(new Date(), userId);
    const [user, plan, currentSubscription] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, locale: true } }),
      this.prisma.plan.findUnique({ where: { id: dto.planId } }),
      this.prisma.subscription.findUnique({ where: { userId }, include: { plan: true } }),
    ]);

    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'User session is invalid' });
    if (!plan || !plan.isActive) throw new NotFoundException({ code: 'not_found', message: 'Plan was not found' });
    if (hasCheckoutConflict(currentSubscription, new Date())) {
      throw new ConflictException({ code: 'already_subscribed', message: 'A current subscription must end before starting a new checkout' });
    }

    const isRecurring = plan.isRecurring && plan.interval !== PlanInterval.LIFETIME;
    if (provider === BillingProvider.YOOKASSA && isRecurring && dto.autoRenewConsent !== true) {
      throw new UnprocessableEntityException({ code: 'consent_required', message: 'Consent to automatic recurring charges is required' });
    }

    if (provider === BillingProvider.YOOKASSA && isRecurring && plan.trialDays > 0) {
      // YooKassa checkout charges the full price immediately; selling a "trial" that way
      // would misrepresent it. Needs the agreed card-binding (zero-payment) flow first.
      throw new UnprocessableEntityException({
        code: 'billing_not_configured',
        message: 'YooKassa trial setup requires the approved zero-payment binding flow before checkout can be enabled',
      });
    }

    const currency = provider === BillingProvider.CREEM ? 'USD' : 'RUB';
    const amount = provider === BillingProvider.CREEM ? plan.priceUsd : plan.priceRub;
    if (amount === null || amount === undefined || amount <= 0) {
      throw new UnprocessableEntityException({
        code: 'billing_not_configured',
        message: `A valid ${currency} price must be configured for this plan`,
      });
    }

    const consentAt = provider === BillingProvider.YOOKASSA && isRecurring ? new Date() : null;
    const consentText = consentAt ? (dto.autoRenewConsentText ?? '').trim() : null;
    if (consentAt && !consentText) {
      // The site sends the exact consent copy shown next to the checkbox; without it
      // there is nothing to store as proof of consent.
      throw new UnprocessableEntityException({
        code: 'consent_required',
        message: 'The auto-renew consent text shown to the user is required',
        fields: { autoRenewConsentText: 'Required for recurring YooKassa plans' },
      });
    }

    // Serialize checkout creation per user. The DB row lock closes the race where
    // two quick clicks both see no pending checkout and create two provider sessions.
    let checkoutInit: { payment: CheckoutPayment; isNew: boolean } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        checkoutInit = await this.prisma.$transaction(async (tx) => {
          const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
          if (lockedUsers.length !== 1) {
            throw new UnauthorizedException({ code: 'unauthorized', message: 'User session is invalid' });
          }
          const latestSubscription = await tx.subscription.findUnique({ where: { userId }, include: { plan: true } });
          const now = new Date();
          if (hasCheckoutConflict(latestSubscription, now)) {
            throw new ConflictException({ code: 'already_subscribed', message: 'A current subscription must end before starting a new checkout' });
          }

          // A past-due YooKassa renewal whose result is still ambiguous must be
          // reconciled before a new purchase, even after the normal retry window.
          const unresolvedRenewal = await tx.payment.findFirst({
            where: {
              userId,
              provider: BillingProvider.YOOKASSA,
              status: PaymentStatus.PENDING,
              purpose: { in: [PaymentPurpose.RENEWAL, PaymentPurpose.RETRY] },
            },
            select: { id: true },
          });
          if (unresolvedRenewal) {
            throw new ConflictException({ code: 'checkout_in_progress', message: 'A previous renewal is still awaiting payment confirmation' });
          }

          const pending = await tx.payment.findFirst({
            where: { userId, purpose: PaymentPurpose.CHECKOUT, status: PaymentStatus.PENDING },
            orderBy: { createdAt: 'desc' },
          });
          // Reuse only a recent attempt for the same plan, provider and stored price.
          // Anything else is replaced; a late provider success on a replaced attempt
          // is still applied (see supersededAt in the payment.succeeded handlers).
          if (
            pending
            && pending.provider === provider
            && pending.planId === plan.id
            && pending.amount === amount
            && pending.currency === currency
            && now.getTime() - pending.createdAt.getTime() < STALE_CHECKOUT_MS
          ) return { payment: pending, isNew: false };
          if (pending) {
            await tx.payment.updateMany({
              where: { userId, purpose: PaymentPurpose.CHECKOUT, status: PaymentStatus.PENDING },
              data: { status: PaymentStatus.CANCELED, supersededAt: now },
            });
          }

          const paymentId = randomUUID();
          const payment = await tx.payment.create({
            data: {
              id: paymentId,
              userId,
              planId: plan.id,
              provider,
              amount,
              currency,
              status: PaymentStatus.PENDING,
              purpose: PaymentPurpose.CHECKOUT,
              idempotencyKey: `checkout:${paymentId}`,
              autoRenewConsentAt: consentAt,
              autoRenewConsentText: consentText,
            },
          });
          return { payment, isNew: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue;
        throw error;
      }
    }
    if (!checkoutInit) throw new Error('Could not safely initialize checkout after transaction retries');

    const { payment } = checkoutInit;
    // A reused attempt matches plan, provider and price (checked in the transaction).
    if (!checkoutInit.isNew && payment.checkoutUrl) return { checkoutUrl: payment.checkoutUrl };
    const idempotencyKey = payment.idempotencyKey ?? `checkout:${payment.id}`;
    const effectiveConsentAt = checkoutInit.isNew ? consentAt : payment.autoRenewConsentAt;
    const effectiveConsentText = checkoutInit.isNew ? consentText : payment.autoRenewConsentText;

    try {
      if (provider === BillingProvider.CREEM) {
        return await this.createCreemCheckout(user, plan, payment.id);
      }
      return await this.createYooKassaCheckout(user, plan, payment.id, idempotencyKey, effectiveConsentAt, effectiveConsentText);
    } catch (error) {
      // Only failures that prove the provider rejected the request (or local
      // preflight/configuration errors before a request) may close the record.
      // A timeout/5xx/invalid success payload may mean a checkout was created;
      // preserve the same payment ID and idempotency key so the next request can
      // safely reconcile/replay it instead of permitting a duplicate charge.
      if (this.isDefinitiveCheckoutFailure(error)) {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED },
        });
      } else {
        this.logger.warn(`Checkout ${payment.id} has an uncertain provider outcome; leaving it pending for safe retry`);
      }
      throw error;
    }
  }

  private isDefinitiveCheckoutFailure(error: unknown): boolean {
    if (error instanceof ProviderHttpException) return error.isDefinitivePaymentRejection;
    return error instanceof ServiceUnavailableException
      || error instanceof UnprocessableEntityException
      || error instanceof NotFoundException;
  }

  async portal(userId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!subscription || subscription.provider !== BillingProvider.CREEM || !subscription.providerCustomerRef) {
      throw new ConflictException({ code: 'not_cancelable', message: 'Billing portal is not available for this subscription' });
    }
    const apiKey = this.config.get<string>('CREEM_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'Creem is not configured' });
    const base = this.config.get<string>('CREEM_API_BASE_URL', this.config.get<string>('NODE_ENV') === 'production' ? 'https://api.creem.io' : 'https://test-api.creem.io');
    const response = await this.providerRequest(`${base}/v1/customers/billing`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: subscription.providerCustomerRef }),
    });
    const url = response.customer_portal_link ?? response.url;
    if (typeof url !== 'string') throw new BadGatewayException({ code: 'internal', message: 'Creem did not return a billing portal URL' });
    return { url };
  }

  async cancel(userId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { userId }, include: { plan: true } });
    if (!subscription || subscription.provider !== BillingProvider.YOOKASSA || !subscription.plan.isRecurring || subscription.plan.interval === PlanInterval.LIFETIME || subscription.status === SubscriptionStatus.CANCELED) {
      throw new ConflictException({ code: 'not_cancelable', message: 'This subscription cannot be canceled here' });
    }
    const updated = await this.prisma.subscription.update({ where: { userId }, data: { cancelAtPeriodEnd: true } });
    return this.publicSubscription(updated);
  }

  async resume(userId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { userId }, include: { plan: true } });
    if (!subscription || subscription.provider !== BillingProvider.YOOKASSA || !subscription.plan.isRecurring || subscription.plan.interval === PlanInterval.LIFETIME || !subscription.cancelAtPeriodEnd || !subscription.currentPeriodEnd || subscription.currentPeriodEnd <= new Date()) {
      throw new ConflictException({ code: 'not_cancelable', message: 'This subscription cannot be resumed' });
    }
    if (!subscription.providerRef) {
      throw new ConflictException({ code: 'payment_method_required', message: 'A saved payment method is required to resume auto-renewal' });
    }
    // A concurrent unlink must not be overwritten by a stale Resume request.
    const resumed = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        provider: BillingProvider.YOOKASSA,
        providerRef: subscription.providerRef,
        paymentMethodRevision: subscription.paymentMethodRevision,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { gt: new Date() },
      },
      data: { cancelAtPeriodEnd: false, paymentMethodRevision: { increment: 1 } },
    });
    if (resumed.count !== 1) {
      const latest = await this.prisma.subscription.findUnique({ where: { userId } });
      if (latest && latest.provider === BillingProvider.YOOKASSA && !latest.providerRef) {
        throw new ConflictException({ code: 'payment_method_required', message: 'A saved payment method is required to resume auto-renewal' });
      }
      throw new ConflictException({ code: 'not_cancelable', message: 'The subscription changed; refresh and retry' });
    }
    const updated = await this.prisma.subscription.findUnique({ where: { id: subscription.id } });
    if (!updated) throw new NotFoundException({ code: 'not_found', message: 'Subscription was not found' });
    return this.publicSubscription(updated);
  }

  /**
   * Unlink a saved YooKassa payment method on our side and stop future renewals.
   * YooKassa does not provide a separate API to delete this saved method. The
   * current paid period remains intact; clearing providerRef makes future worker
   * runs ineligible to create a renewal charge.
   */
  async unlinkPaymentMethod(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findUnique({ where: { userId }, include: { plan: true } });
      if (!subscription || subscription.provider !== BillingProvider.YOOKASSA || !subscription.plan.isRecurring || subscription.plan.interval === PlanInterval.LIFETIME || !subscription.providerRef) {
        throw new ConflictException({ code: 'not_cancelable', message: 'There is no saved YooKassa payment method to unlink' });
      }

      // Do not report a successful unlink while a renewal has already been
      // handed to YooKassa. The caller can retry once that payment is resolved.
      const pendingRenewal = await tx.payment.findFirst({
        where: {
          subscriptionId: subscription.id,
          provider: BillingProvider.YOOKASSA,
          status: PaymentStatus.PENDING,
          purpose: { in: [PaymentPurpose.RENEWAL, PaymentPurpose.RETRY] },
        },
        select: { id: true },
      });
      if (pendingRenewal) {
        throw new ConflictException({ code: 'not_cancelable', message: 'A renewal payment is being processed; retry unlinking after its status is resolved' });
      }

      const cleared = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          provider: BillingProvider.YOOKASSA,
          providerRef: subscription.providerRef,
          paymentMethodRevision: subscription.paymentMethodRevision,
        },
        data: {
          paymentMethodRevision: { increment: 1 },
          providerRef: null,
          paymentMethodType: null,
          paymentMethodCardType: null,
          paymentMethodLast4: null,
          paymentMethodExpiryMonth: null,
          paymentMethodExpiryYear: null,
          cancelAtPeriodEnd: true,
          nextRetryAt: null,
        },
      });
      if (cleared.count !== 1) {
        throw new ConflictException({ code: 'not_cancelable', message: 'The saved payment method changed; refresh the subscription and retry' });
      }

      const updated = await tx.subscription.findUnique({ where: { id: subscription.id } });
      if (!updated) throw new NotFoundException({ code: 'not_found', message: 'Subscription was not found' });
      return this.publicSubscription(updated);
    });
  }

  private async createCreemCheckout(
    user: { id: string; email: string; locale: string },
    plan: { id: string; creemProductId: string | null },
    paymentId: string,
  ) {
    if (!plan.creemProductId) {
      throw new UnprocessableEntityException({ code: 'billing_not_configured', message: 'Creem product ID is not configured for this plan' });
    }
    const apiKey = this.config.get<string>('CREEM_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'Creem is not configured' });
    const base = this.config.get<string>('CREEM_API_BASE_URL', this.config.get<string>('NODE_ENV') === 'production' ? 'https://api.creem.io' : 'https://test-api.creem.io');
    const response = await this.providerRequest(`${base}/v1/checkouts`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: plan.creemProductId,
        request_id: paymentId,
        success_url: this.successUrl(),
        customer: { email: user.email },
        metadata: { userId: user.id, planId: plan.id, paymentId, locale: user.locale },
      }),
    });
    const url = response.checkout_url;
    if (typeof url !== 'string') throw new BadGatewayException({ code: 'internal', message: 'Creem did not return a checkout URL' });
    const providerId = typeof response.id === 'string' ? response.id : null;
    await this.prisma.payment.update({ where: { id: paymentId }, data: { providerPaymentId: providerId, checkoutUrl: url } });
    return { checkoutUrl: url };
  }

  private async createYooKassaCheckout(
    user: { id: string; email: string; locale: string },
    plan: { id: string; names: Prisma.JsonValue; interval: PlanInterval; isRecurring: boolean; trialDays: number },
    paymentId: string,
    idempotencyKey: string,
    consentAt: Date | null,
    consentText: string | null,
  ) {
    const shopId = this.config.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.config.get<string>('YOOKASSA_SECRET_KEY');
    if (!shopId || !secretKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa is not configured' });
    // Plans with trialDays > 0 are rejected in checkout() for YooKassa (see the trial guard).
    const vatCode = this.config.get<string>('YOOKASSA_RECEIPT_VAT_CODE');
    if (!vatCode && this.config.get<string>('NODE_ENV') === 'production') {
      throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa receipt VAT code must be configured before production payments' });
    }
    const planNames = this.asRecord(plan.names);
    const planName = String(planNames[user.locale] ?? planNames.en ?? plan.id).slice(0, 128);
    const amountRub = await this.getPaymentAmount(paymentId);
    const amount = (amountRub / 100).toFixed(2);
    const currency = 'RUB';
    const receipt = vatCode ? {
      customer: { email: user.email },
      items: [{
        description: planName,
        quantity: '1.00',
        amount: { value: amount, currency },
        vat_code: Number(vatCode),
        payment_mode: 'full_prepayment',
        payment_subject: 'service',
      }],
      ...(this.config.get<string>('YOOKASSA_TAX_SYSTEM_CODE')
        ? { tax_system_code: Number(this.config.get<string>('YOOKASSA_TAX_SYSTEM_CODE')) }
        : {}),
    } : undefined;

    const base = this.config.get<string>('YOOKASSA_API_BASE_URL', 'https://api.yookassa.ru/v3');
    const response = await this.providerRequest(`${base}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotencyKey,
      },
      body: JSON.stringify({
        amount: { value: amount, currency },
        capture: true,
        confirmation: { type: 'redirect', return_url: this.successUrl() },
        description: `ColorPicker — ${planName}`.slice(0, 128),
        save_payment_method: Boolean(consentAt),
        metadata: { userId: user.id, planId: plan.id, paymentId, purpose: 'checkout' },
        ...(receipt ? { receipt } : {}),
      }),
    });
    const url = response.confirmation?.confirmation_url;
    if (typeof url !== 'string' || typeof response.id !== 'string') {
      throw new BadGatewayException({ code: 'internal', message: 'YooKassa did not return a valid checkout response' });
    }
    await this.prisma.payment.update({ where: { id: paymentId }, data: { providerPaymentId: response.id, checkoutUrl: url } });
    // Consent timestamp and text are stored on the payment before redirection and copied to Subscription after success.
    return { checkoutUrl: url };
  }

  async handleCreemWebhook(rawBody: Buffer, signature: string | undefined, payload: Record<string, unknown>, remoteIp = 'unknown') {
    const secret = this.config.get<string>('CREEM_WEBHOOK_SECRET');
    if (!secret) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'Creem webhook secret is not configured' });
    if (!signature || !this.validCreemSignature(rawBody, signature, secret)) {
      this.logger.warn(`Rejected Creem webhook from ${remoteIp}: ${signature ? 'invalid' : 'missing'} creem-signature`);
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Webhook signature is invalid' });
    }

    const eventType = String(payload['eventType'] ?? payload['event_type'] ?? payload['type'] ?? '');
    const eventId = String(payload['id'] ?? payload['event_id'] ?? `${eventType}:${this.findNestedId(payload)}`);
    if (!eventType || !eventId) throw new UnprocessableEntityException({ code: 'bad_request', message: 'Webhook event is malformed' });
    const event = await this.beginEvent(BillingProvider.CREEM, eventId, eventType, payload);
    if (!event.shouldProcess) {
      if (event.alreadyProcessed) return { received: true };
      throw new ServiceUnavailableException({ code: 'internal', message: 'Webhook event is already being processed; retry later' });
    }
    try {
      await this.applyCreemEvent(eventType, payload);
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), processingAt: null, processingError: null } });
    } catch (error) {
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { processingAt: null, processingError: this.errorMessage(error).slice(0, 2000) } }).catch(() => undefined);
      throw error;
    }
    return { received: true };
  }

  async handleYooKassaWebhook(
    payload: Record<string, unknown>,
    remoteIp: string,
  ) {
    this.assertYooKassaIp(remoteIp);
    const eventType = String(payload['event'] ?? '');
    const object = payload['object'] && typeof payload['object'] === 'object' ? payload['object'] as Record<string, unknown> : {};
    const objectId = String(object['id'] ?? '');
    if (!eventType || !objectId) throw new UnprocessableEntityException({ code: 'bad_request', message: 'Webhook event is malformed' });
    // The resolved address shows whether TRUST_PROXY_HOPS matches the proxy chain in front of the API.
    this.logger.log(`Accepted YooKassa webhook ${eventType} for ${objectId} from ${remoteIp}`);
    const eventId = `${eventType}:${objectId}`;
    const event = await this.beginEvent(BillingProvider.YOOKASSA, eventId, eventType, payload);
    if (!event.shouldProcess) {
      if (event.alreadyProcessed) return { received: true };
      throw new ServiceUnavailableException({ code: 'internal', message: 'Webhook event is already being processed; retry later' });
    }
    try {
      if (eventType === 'refund.succeeded') {
        const confirmedRefund = await this.fetchYooKassaRefund(objectId);
        await this.applyYooKassaRefund(confirmedRefund);
      } else {
        const confirmedPayment = await this.fetchYooKassaPayment(objectId);
        await this.applyYooKassaEvent(eventType, confirmedPayment);
      }
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), processingAt: null, processingError: null } });
    } catch (error) {
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { processingAt: null, processingError: this.errorMessage(error).slice(0, 2000) } }).catch(() => undefined);
      throw error;
    }
    return { received: true };
  }

  private async applyCreemEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const data = this.extractProviderData(payload);
    const metadata = this.extractMetadata(data);
    const paymentId = this.stringValue(metadata['paymentId'] ?? metadata['payment_id']);
    const userIdFromMetadata = this.stringValue(metadata['userId'] ?? metadata['user_id']);
    const planIdFromMetadata = this.stringValue(metadata['planId'] ?? metadata['plan_id']);
    const nestedSubscription = this.asRecord(data['subscription']);
    const nestedCustomer = this.asRecord(data['customer']);
    const providerRef = this.stringValue(data['subscription_id'] ?? data['subscriptionId'])
      ?? this.stringValue(data['subscription'])
      ?? this.stringValue(nestedSubscription['id'])
      ?? this.stringValue(data['id']);
    // Creem payloads use both expanded objects (checkout events) and string
    // references (some subscription events) for customer/subscription fields.
    const customerRef = this.stringValue(data['customer_id'] ?? data['customerId'] ?? data['customer'])
      ?? this.stringValue(nestedCustomer['id']);

    const transactionRef = this.creemTransactionReference(data);
    const orderRef = this.creemOrderReference(data);
    let payment = paymentId ? await this.prisma.payment.findUnique({ where: { id: paymentId } }) : null;
    if (payment && payment.provider !== BillingProvider.CREEM) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem webhook points to a payment owned by another provider' });
    }
    if (!payment && transactionRef) {
      payment = await this.prisma.payment.findFirst({
        where: { provider: BillingProvider.CREEM, providerTransactionRef: transactionRef },
      });
    }
    if (!payment && eventType.startsWith('subscription.') && customerRef) {
      const pendingMatches = await this.prisma.payment.findMany({
        where: {
          provider: BillingProvider.CREEM,
          providerCustomerRef: customerRef,
          purpose: PaymentPurpose.CHECKOUT,
          status: PaymentStatus.PENDING,
        },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      // There should be one pending checkout per customer. If the result is
      // ambiguous, fail closed instead of associating an event to another purchase.
      if (pendingMatches.length === 1) payment = pendingMatches[0];
    }
    // Never associate a payment/refund with the latest purchase for a customer:
    // one customer may make several purchases, and a delayed event for an older
    // transaction must not mutate a newer payment or Lifetime entitlement.
    if (payment && userIdFromMetadata && userIdFromMetadata !== payment.userId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem user metadata does not match the local payment' });
    }
    if (payment && planIdFromMetadata && planIdFromMetadata !== payment.planId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem plan metadata does not match the local payment' });
    }
    let userId = userIdFromMetadata ?? payment?.userId;
    let planId = planIdFromMetadata ?? payment?.planId;
    let current = providerRef ? await this.prisma.subscription.findFirst({ where: { provider: BillingProvider.CREEM, providerRef } }) : null;
    // If an external subscription reference is present but unknown locally, do
    // not fall back to the customer's latest subscription: that could associate
    // a delayed event from an old provider subscription with a newer purchase.
    if (!current && !providerRef && customerRef) current = await this.prisma.subscription.findFirst({ where: { provider: BillingProvider.CREEM, providerCustomerRef: customerRef } });
    userId ??= current?.userId;
    planId ??= current?.planId;

    // One-time Lifetime access must be revoked after a confirmed full refund.
    // Creem represents this as refund.created, with transaction.status='refunded'.
    // Recurring-plan refund policy remains a client decision, so don't silently
    // terminate a recurring subscription when an individual charge is refunded.
    if (eventType === 'refund.created') {
      await this.applyCreemRefund(data, payment);
      return;
    }

    const statusMap: Record<string, SubscriptionStatus | null> = {
      'subscription.trialing': SubscriptionStatus.TRIALING,
      'subscription.active': SubscriptionStatus.ACTIVE,
      'subscription.paid': SubscriptionStatus.ACTIVE,
      'subscription.past_due': SubscriptionStatus.PAST_DUE,
      'subscription.scheduled_cancel': null,
      'subscription.canceled': SubscriptionStatus.CANCELED,
      'subscription.expired': SubscriptionStatus.CANCELED,
      'subscription.unpaid': SubscriptionStatus.CANCELED,
      'checkout.completed': null,
    };
    if (!(eventType in statusMap)) return;

    if (eventType === 'subscription.scheduled_cancel') {
      if (current) await this.prisma.subscription.update({ where: { id: current.id }, data: { cancelAtPeriodEnd: true } });
      return;
    }
    if (!userId || !planId) {
      if (eventType.startsWith('checkout.')) return;
      throw new UnprocessableEntityException({ code: 'bad_request', message: 'Webhook lacks a mapped user or plan' });
    }
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new UnprocessableEntityException({ code: 'bad_request', message: 'Webhook references an unknown plan' });
    if (eventType === 'checkout.completed') {
      this.assertCreemCheckoutMatchesPlan(data, plan);
    }

    if (current && current.userId !== userId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem subscription reference belongs to a different user' });
    }

    // One user can have only one current entitlement in our model. A delayed
    // webhook for a different external subscription must not overwrite a newer
    // subscription that still grants access. A new purchase may replace an old
    // subscription only after its entitlement has ended/revoked.
    const existingForUser = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
    const canReplaceExisting = !existingForUser || !grantsPremiumAccess({
      provider: existingForUser.provider,
      status: existingForUser.status,
      trialEnd: existingForUser.trialEnd,
      currentPeriodEnd: existingForUser.currentPeriodEnd,
      cancelAtPeriodEnd: existingForUser.cancelAtPeriodEnd,
      planInterval: existingForUser.plan.interval,
    });
    const eventCanCreateOrReplacePurchase = eventType.startsWith('subscription.')
      || (eventType === 'checkout.completed' && plan.interval === PlanInterval.LIFETIME);
    if (
      eventCanCreateOrReplacePurchase
      && existingForUser
      && existingForUser.id !== current?.id
      && !canReplaceExisting
    ) {
      this.logger.error(`Ignoring Creem event ${eventType} for user ${userId}: it references a different subscription while ${existingForUser.id} still grants access`);
      return;
    }
    // A delayed successful event must never resurrect a Lifetime purchase that
    // has already been fully refunded. A new checkout carries its own paymentId.
    if (payment?.status === PaymentStatus.REFUNDED && eventType.startsWith('subscription.')) {
      this.logger.warn(`Ignoring delayed Creem subscription event ${eventType} for refunded payment ${payment.id}`);
      return;
    }
    if (
      payment
      && (payment.status === PaymentStatus.FAILED || (payment.status === PaymentStatus.CANCELED && !payment.supersededAt))
      && (eventType === 'subscription.active' || eventType === 'subscription.paid')
    ) {
      this.logger.warn(`Ignoring Creem positive event ${eventType} for non-pending failed/canceled payment ${payment.id}`);
      return;
    }
    // Only positive billing events may settle the local payment record. A
    // subscription cancellation, expiry, unpaid or past_due event must never
    // make an earlier payment look newly successful.
    const confirmsPayment = eventType === 'subscription.active'
      || eventType === 'subscription.paid'
      || (eventType === 'checkout.completed' && plan.interval === PlanInterval.LIFETIME);

    // Recurring checkout completion confirms that checkout was created/paid,
    // but subscription entitlement must wait for a subscription lifecycle event.
    // Store its immutable order mapping so a refund arriving early can be retried
    // and correlated to this exact checkout instead of guessing by customer.
    if (eventType === 'checkout.completed' && plan.interval !== PlanInterval.LIFETIME) {
      if (payment) {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            ...(customerRef ? { providerCustomerRef: customerRef } : {}),
            ...(orderRef ? { providerOrderRef: orderRef } : {}),
            ...(transactionRef ? { providerTransactionRef: transactionRef } : {}),
          },
        });
      }
      return;
    }

    const periodEnd = this.parseProviderDate(data['current_period_end'] ?? data['current_period_end_date'] ?? data['currentPeriodEnd'] ?? data['ends_at']);
    // Creem can represent the trial boundary as current_period_end_date on a
    // subscription.trialing event rather than a dedicated trial_end field.
    const trialEnd = this.parseProviderDate(
      data['trial_ends_at'] ?? data['trial_end'] ?? data['trialEnd']
        ?? (eventType === 'subscription.trialing' ? periodEnd?.toISOString() : undefined),
    );
    let status = statusMap[eventType];
    if (eventType === 'checkout.completed') status = SubscriptionStatus.ACTIVE;
    if (
      plan.interval !== PlanInterval.LIFETIME &&
      (status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING) &&
      !periodEnd && !current?.currentPeriodEnd
    ) {
      throw new UnprocessableEntityException({ code: 'bad_request', message: 'Creem subscription event is missing current period end' });
    }

    // Do not create a new subscription from a provider event that cannot be
    // correlated to one of our checkout attempts. Existing subscriptions can
    // still be updated by lifecycle events that do not carry payment metadata.
    if (!current && !payment && eventType.startsWith('subscription.')) {
      throw new ServiceUnavailableException({
        code: 'internal',
        message: 'Creem subscription event is not yet mapped to a local checkout; retry after checkout event processing',
      });
    }

    // A terminal lifecycle event can close an uncharged checkout that only
    // created a trial subscription. Otherwise its PENDING row would block a
    // fresh checkout forever after the trial was canceled/expired/unpaid.
    // Payment status is guarded in the transaction, so an already confirmed
    // payment can never be downgraded by a delayed terminal event.
    const terminatesPendingCheckout = [
      'subscription.canceled',
      'subscription.expired',
      'subscription.unpaid',
    ].includes(eventType);

    // Commit the payment success, entitlement upsert and payment->subscription
    // relationship as one atomic unit. This prevents refund.created racing with
    // checkout.completed and observing an order mapping without the matching
    // entitlement (or a successful payment without its subscription link).
    let entitlementApplied = true;
    await this.prisma.$transaction(async (tx) => {
      if (payment) {
        if (confirmsPayment) {
          const claimed = await tx.payment.updateMany({
            where: {
              id: payment!.id,
              provider: BillingProvider.CREEM,
              // A superseded checkout that Creem reports as paid is still a real payment.
              OR: [
                { status: { in: [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED] } },
                { status: PaymentStatus.CANCELED, supersededAt: { not: null } },
              ],
            },
            data: {
              status: PaymentStatus.SUCCEEDED,
              ...(customerRef ? { providerCustomerRef: customerRef } : {}),
              ...(eventType === 'checkout.completed' && orderRef ? { providerOrderRef: orderRef } : {}),
              ...(eventType === 'checkout.completed' && transactionRef ? { providerTransactionRef: transactionRef } : {}),
            },
          });
          if (claimed.count !== 1) {
            entitlementApplied = false;
            return;
          }
        } else if (customerRef) {
          await tx.payment.update({ where: { id: payment.id }, data: { providerCustomerRef: customerRef } });
        }
        if (terminatesPendingCheckout) {
          await tx.payment.updateMany({
            where: {
              id: payment.id,
              provider: BillingProvider.CREEM,
              purpose: PaymentPurpose.CHECKOUT,
              status: PaymentStatus.PENDING,
            },
            data: { status: PaymentStatus.CANCELED },
          });
        }
      }

      const subscription = await tx.subscription.upsert({
        where: { userId },
        create: {
          userId,
          provider: BillingProvider.CREEM,
          planId,
          status: status ?? SubscriptionStatus.ACTIVE,
          trialEnd,
          currentPeriodEnd: plan.interval === PlanInterval.LIFETIME ? null : periodEnd,
          providerRef: plan.interval === PlanInterval.LIFETIME ? null : providerRef,
          providerCustomerRef: customerRef,
          cancelAtPeriodEnd: false,
        },
        update: {
          provider: BillingProvider.CREEM,
          planId,
          ...(status ? { status } : {}),
          ...(trialEnd ? { trialEnd } : {}),
          currentPeriodEnd: plan.interval === PlanInterval.LIFETIME ? null : periodEnd ?? current?.currentPeriodEnd,
          providerRef: plan.interval === PlanInterval.LIFETIME ? null : providerRef ?? current?.providerRef,
          providerCustomerRef: customerRef ?? current?.providerCustomerRef,
          ...(eventType === 'checkout.completed' ? { cancelAtPeriodEnd: false } : {}),
        },
      });
      if (payment && (confirmsPayment || eventType.startsWith('subscription.'))) {
        // Link trial and terminal lifecycle events too, not just paid events,
        // so canceled/expired unpaid checkouts retain an auditable subscription.
        await tx.payment.update({ where: { id: payment.id }, data: { subscriptionId: subscription.id } });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!entitlementApplied) {
      this.logger.warn(`Ignoring Creem success event ${eventType} because payment ${payment?.id ?? '(unknown)'} is no longer pending/successful`);
    }
  }

  private creemOrderReference(data: Record<string, unknown>): string | null {
    const order = this.asRecord(data['order']);
    return this.stringValue(data['order_id'] ?? data['orderId'])
      ?? this.stringValue(order['id'])
      ?? this.stringValue(data['order'])
      ?? null;
  }

  private creemTransactionReference(data: Record<string, unknown>): string | null {
    const transaction = this.asRecord(data['transaction']);
    const order = this.asRecord(data['order']);
    const orderTransaction = this.asRecord(order['transaction']);
    return this.stringValue(data['transaction_id'] ?? data['transactionId'])
      ?? this.stringValue(data['transaction'])
      ?? this.stringValue(transaction['id'])
      ?? this.stringValue(order['transaction'])
      ?? this.stringValue(orderTransaction['id'])
      ?? null;
  }

  private assertCreemCheckoutMatchesPlan(
    data: ProviderPayment,
    plan: { id: string; priceUsd: number; creemProductId: string | null; isRecurring: boolean; interval: PlanInterval },
  ): void {
    const product = this.asRecord(data.product);
    const order = this.asRecord(data.order);
    const productId = this.stringValue(data.product_id)
      ?? this.stringValue(data.product)
      ?? this.stringValue(product['id'])
      ?? this.stringValue(order['product']);
    if (!plan.creemProductId || !productId || productId !== plan.creemProductId) {
      throw new UnprocessableEntityException({
        code: 'bad_request',
        message: 'Creem checkout product does not match the configured plan',
      });
    }

    // The checkout.completed payload expands the product. Validate the source
    // of truth configured in Creem, not only the locally displayed price.
    const productPrice = product['price'];
    const productCurrency = this.stringValue(product['currency']);
    if (typeof productPrice !== 'number' || !Number.isInteger(productPrice) || productCurrency !== 'USD') {
      throw new UnprocessableEntityException({
        code: 'bad_request',
        message: 'Creem checkout is missing a valid USD product price',
      });
    }
    if (productPrice !== plan.priceUsd) {
      throw new UnprocessableEntityException({
        code: 'bad_request',
        message: 'Creem product price does not match the configured plan price',
      });
    }

    const billingType = this.stringValue(product['billing_type']);
    const shouldBeRecurring = plan.isRecurring && plan.interval !== PlanInterval.LIFETIME;
    if (billingType && billingType !== (shouldBeRecurring ? 'recurring' : 'onetime')) {
      throw new UnprocessableEntityException({
        code: 'bad_request',
        message: 'Creem product billing type does not match the configured plan',
      });
    }
  }

  private async applyCreemRefund(
    refund: ProviderPayment,
    mappedPayment: {
      id: string;
      userId: string;
      planId: string;
      provider: BillingProvider;
      status: PaymentStatus;
      subscriptionId: string | null;
      providerOrderRef: string | null;
    } | null,
  ): Promise<void> {
    if (refund.status !== 'succeeded') {
      this.logger.warn(`Creem refund ${refund.id ?? '(unknown)'} is not succeeded; no entitlement was revoked`);
      return;
    }
    const refundTransaction = this.asRecord(refund.transaction);
    const transactionId = this.stringValue(refundTransaction['id']) ?? this.stringValue(refund.transaction);
    if (!transactionId) {
      this.logger.warn(`Creem refund ${refund.id ?? '(unknown)'} has no transaction ID; no entitlement was revoked`);
      return;
    }

    // The refund webhook does not reliably carry the order reference. Resolve
    // the transaction with Creem and correlate via its immutable order ID rather
    // than guessing the customer's most recent purchase.
    const confirmedTransaction = await this.fetchCreemTransaction(transactionId);
    const confirmedTransactionId = this.stringValue(confirmedTransaction.id);
    const confirmedStatus = this.stringValue(confirmedTransaction.status);
    const confirmedOrder = confirmedTransaction.order;
    const confirmedOrderRecord = this.asRecord(confirmedOrder);
    const orderRef = this.stringValue(confirmedOrderRecord['id']) ?? this.stringValue(confirmedOrder);
    if (confirmedTransactionId !== transactionId || confirmedStatus !== 'refunded' || !orderRef) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem transaction does not confirm a full refund for a resolvable order' });
    }

    let payment = mappedPayment
      ? await this.prisma.payment.findUnique({ where: { id: mappedPayment.id }, include: { plan: true } })
      : null;
    if (payment && payment.providerOrderRef !== orderRef) {
      if (!payment.providerOrderRef) {
        // A known local checkout may be found by payment metadata before its
        // checkout.completed event has persisted the order reference. This is
        // a transient ordering race, not evidence of a forged refund.
        throw new ServiceUnavailableException({ code: 'internal', message: 'Creem checkout order mapping is not yet persisted; retry refund webhook later' });
      }
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Creem refund order does not match the mapped checkout payment' });
    }
    payment ??= await this.prisma.payment.findFirst({
      where: { provider: BillingProvider.CREEM, providerOrderRef: orderRef },
      include: { plan: true },
    });
    if (!payment || payment.provider !== BillingProvider.CREEM || payment.providerOrderRef !== orderRef) {
      // checkout.completed may still be in flight. Returning success here would
      // permanently acknowledge a refund before its local payment mapping exists.
      // Ask Creem to retry; once checkout mapping commits, this refund is exact.
      this.logger.warn(`Creem refund ${refund.id ?? '(unknown)'} has no exact local order mapping for ${orderRef}; requesting webhook retry`);
      throw new ServiceUnavailableException({ code: 'internal', message: 'Creem refund is not yet mapped to a local checkout; retry later' });
    }
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      this.logger.warn(`Creem refund ${refund.id ?? '(unknown)'} points to payment ${payment.id} that is not locally successful`);
      return;
    }
    if (payment.plan.interval !== PlanInterval.LIFETIME) {
      // The client has not set recurring-subscription refund policy. Preserve the
      // event for audit rather than ending a paid recurring period implicitly.
      this.logger.warn(`Creem refund ${refund.id ?? '(unknown)'} concerns recurring payment ${payment.id}; refund access policy remains pending client confirmation`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment!.id, provider: BillingProvider.CREEM, status: PaymentStatus.SUCCEEDED },
        data: { status: PaymentStatus.REFUNDED },
      });
      if (claimed.count !== 1) return;
      // Revoke access only if this exact purchase is still the source of the
      // user's current Lifetime entitlement. An old refund must not revoke a
      // newer Lifetime purchase by the same customer.
      const current = await tx.subscription.findUnique({ where: { userId: payment!.userId } });
      const exactCurrentEntitlement = current
        && current.provider === BillingProvider.CREEM
        && current.planId === payment!.planId
        && payment!.subscriptionId === current.id;
      if (exactCurrentEntitlement) {
        await tx.subscription.update({
          where: { id: current.id },
          data: { status: SubscriptionStatus.CANCELED, cancelAtPeriodEnd: false, currentPeriodEnd: new Date(), nextRetryAt: null },
        });
      }
    });
  }

  private async applyYooKassaRefund(refund: ProviderPayment): Promise<void> {
    if (!refund.id || refund.status !== 'succeeded' || !refund.payment_id) {
      throw new UnprocessableEntityException({ code: 'bad_request', message: 'YooKassa refund object is incomplete or not succeeded' });
    }
    const originalPayment = await this.fetchYooKassaPayment(refund.payment_id);
    if (originalPayment.id !== refund.payment_id || originalPayment.status !== 'succeeded') {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Refund does not reference a successful payment' });
    }
    const payment = await this.prisma.payment.findFirst({
      where: { provider: BillingProvider.YOOKASSA, providerPaymentId: refund.payment_id },
      include: { plan: true },
    });
    if (!payment) {
      this.logger.warn(`Ignoring YooKassa refund ${refund.id}: no local payment mapping for ${refund.payment_id}`);
      return;
    }
    const amountText = refund.amount?.value;
    const individualRefundAmount = typeof amountText === 'string' && /^\d+(?:\.\d{1,2})?$/.test(amountText)
      ? Math.round(Number(amountText) * 100)
      : NaN;
    if (!Number.isFinite(individualRefundAmount) || refund.amount?.currency !== payment.currency || individualRefundAmount <= 0 || individualRefundAmount > payment.amount) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa refund amount does not match the local payment' });
    }
    const totalRefundText = originalPayment.refunded_amount?.value;
    const totalRefundedAmount = typeof totalRefundText === 'string' && /^\d+(?:\.\d{1,2})?$/.test(totalRefundText)
      ? Math.round(Number(totalRefundText) * 100)
      : individualRefundAmount;
    if (totalRefundedAmount < payment.amount) {
      // A partial refund is recorded, but it does not revoke the entire entitlement.
      this.logger.warn(`Partial YooKassa refund ${refund.id} for payment ${payment.id}; no access change was made`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // A refund can arrive before the payment.succeeded webhook has been
      // processed locally. Claim only a pending/successful payment; do not turn
      // an already failed/canceled payment into a refund or let a late refund
      // event overwrite a newer payment state.
      const claimed = await tx.payment.updateMany({
        where: {
          id: payment.id,
          provider: BillingProvider.YOOKASSA,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED] },
        },
        data: { status: PaymentStatus.REFUNDED },
      });
      if (claimed.count !== 1) return;

      if (payment.plan.interval === PlanInterval.LIFETIME) {
        const subscription = await tx.subscription.findUnique({ where: { userId: payment.userId } });
        // Revoke only when this exact purchase still funds the current
        // Lifetime entitlement. A delayed refund for an older Lifetime order
        // must not revoke a newer Lifetime purchase by the same user.
        const exactCurrentEntitlement = subscription
          && subscription.id === payment.subscriptionId
          && subscription.planId === payment.planId
          && subscription.provider === BillingProvider.YOOKASSA;
        if (exactCurrentEntitlement) {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              status: SubscriptionStatus.CANCELED,
              cancelAtPeriodEnd: false,
              currentPeriodEnd: new Date(),
              nextRetryAt: null,
            },
          });
        }
      } else {
        // The client has not yet specified recurring-subscription refund policy.
        // Keep this payment/audit trail accurate without silently canceling later paid periods.
        this.logger.warn(`Full refund ${refund.id} recorded for recurring payment ${payment.id}; subscription access policy needs confirmation`);
      }
    });
  }

  private async applyYooKassaEvent(eventType: string, paymentObject: ProviderPayment): Promise<void> {
    const providerPaymentId = paymentObject.id;
    if (!providerPaymentId) throw new UnprocessableEntityException({ code: 'bad_request', message: 'Payment object has no ID' });
    const metadata = paymentObject.metadata ?? {};
    const metadataPaymentId = typeof metadata['paymentId'] === 'string' ? metadata['paymentId'] as string : undefined;

    // A provider can deliver a webhook before the checkout request has persisted
    // its returned providerPaymentId. Metadata carries our local payment UUID,
    // so resolve by that stable identifier first to avoid losing a successful payment.
    let payment = metadataPaymentId
      ? await this.prisma.payment.findFirst({
          where: { id: metadataPaymentId, provider: BillingProvider.YOOKASSA },
          include: { plan: true },
        })
      : null;
    payment ??= await this.prisma.payment.findFirst({
      where: { provider: BillingProvider.YOOKASSA, providerPaymentId },
      include: { plan: true },
    });
    if (!payment) {
      this.logger.warn(`Ignoring YooKassa payment ${providerPaymentId}: no local payment mapping`);
      return;
    }
    if (payment.providerPaymentId && payment.providerPaymentId !== providerPaymentId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa payment ID does not match the local payment' });
    }
    const alreadyMapped = await this.prisma.payment.findFirst({
      where: { provider: BillingProvider.YOOKASSA, providerPaymentId, NOT: { id: payment.id } },
      select: { id: true },
    });
    if (alreadyMapped) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa payment ID is already mapped to another local payment' });
    }

    const amountText = paymentObject.amount?.value;
    const receivedAmount = typeof amountText === 'string' && /^\d+(?:\.\d{1,2})?$/.test(amountText)
      ? Math.round(Number(amountText) * 100)
      : NaN;
    if (!Number.isFinite(receivedAmount) || receivedAmount !== payment.amount || paymentObject.amount?.currency !== payment.currency) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa amount does not match the local payment' });
    }
    if (metadataPaymentId && metadataPaymentId !== payment.id) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa payment metadata does not match' });
    }
    if (metadata['userId'] && metadata['userId'] !== payment.userId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa user metadata does not match' });
    }
    if (metadata['planId'] && metadata['planId'] !== payment.planId) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'YooKassa plan metadata does not match' });
    }

    if (eventType === 'payment.succeeded' && paymentObject.status === 'succeeded') {
      // Event-level idempotency is not enough: one payment can be mentioned by
      // more than one provider event. Never advance a billing period twice for
      // a payment that has already been applied locally.
      if (payment.status === PaymentStatus.SUCCEEDED) return;
      const result = await this.prisma.$transaction(async (tx) => {
        // Claim the local payment atomically. Two distinct provider event IDs
        // can describe the same successful payment, so the outer read alone is
        // not sufficient to prevent two concurrent period updates.
        const claimed = await tx.payment.updateMany({
          where: {
            id: payment.id,
            // A superseded checkout (expired/replaced locally) that YooKassa confirms
            // as paid is a real payment: apply it rather than drop the user's money.
            OR: [{ status: PaymentStatus.PENDING }, { status: PaymentStatus.CANCELED, supersededAt: { not: null } }],
          },
          data: { status: PaymentStatus.SUCCEEDED, providerPaymentId },
        });
        if (claimed.count !== 1) return 'not-claimed' as const;

        const isLifetime = payment.plan.interval === PlanInterval.LIFETIME;
        const isRecurring = payment.plan.isRecurring && !isLifetime;
        const isSubscriptionCharge = payment.purpose === PaymentPurpose.RENEWAL || payment.purpose === PaymentPurpose.RETRY;
        const now = new Date();
        const currentEnd = isLifetime ? null : addBillingInterval(now, payment.plan.interval);
        const existingSubscription = await tx.subscription.findUnique({
          where: { userId: payment.userId },
          include: { plan: true },
        });

        if (isSubscriptionCharge) {
          const matchesOriginalSubscription = Boolean(
            payment.subscriptionId
            && existingSubscription
            && existingSubscription.id === payment.subscriptionId
            && existingSubscription.userId === payment.userId
            && existingSubscription.provider === BillingProvider.YOOKASSA
            && existingSubscription.planId === payment.planId
            && !existingSubscription.cancelAtPeriodEnd
            && existingSubscription.currentPeriodEnd
            && existingSubscription.currentPeriodEnd <= now
            && (existingSubscription.status === SubscriptionStatus.ACTIVE
              || existingSubscription.status === SubscriptionStatus.PAST_DUE),
          );
          if (!matchesOriginalSubscription || !existingSubscription) {
            // The provider did charge this exact renewal payment, so keep the
            // payment record truthful, but don't let a delayed old charge
            // overwrite a newer subscription. Ops can reconcile/refund it.
            return 'subscription-mismatch' as const;
          }

          const renewalMethod = resolveRenewalPaymentMethod(existingSubscription, paymentObject.payment_method);
          const methodId = renewalMethod.providerRef;
          const subscription = await tx.subscription.update({
            where: { id: existingSubscription.id },
            data: {
              status: SubscriptionStatus.ACTIVE,
              trialEnd: null,
              currentPeriodEnd: currentEnd,
              cancelAtPeriodEnd: !methodId,
              providerRef: methodId,
              paymentMethodRevision: { increment: 1 },
              paymentMethodType: renewalMethod.paymentMethodType,
              paymentMethodCardType: renewalMethod.paymentMethodCardType,
              paymentMethodLast4: renewalMethod.paymentMethodLast4,
              paymentMethodExpiryMonth: renewalMethod.paymentMethodExpiryMonth,
              paymentMethodExpiryYear: renewalMethod.paymentMethodExpiryYear,
              retryCount: 0,
              nextRetryAt: null,
            },
          });
          await tx.payment.update({ where: { id: payment.id }, data: { subscriptionId: subscription.id } });
          return 'applied' as const;
        }

        // A delayed checkout success must not replace another still-entitled
        // subscription that was created after this checkout was initiated.
        const existingStillEntitled = hasCheckoutConflict(existingSubscription, now);
        if (existingStillEntitled) return 'subscription-mismatch' as const;

        const returnedCard = isRecurring ? parseSavedYooKassaBankCard(paymentObject.payment_method) : null;
        // Token persistence must not depend on whether the response contains all
        // the optional card-display fields (legacy subscriptions may lack them).
        const methodId = isRecurring ? parseSavedYooKassaPaymentMethodId(paymentObject.payment_method) : null;
        const cancelAtPeriodEnd = isRecurring && !methodId;
        if (cancelAtPeriodEnd) {
          this.logger.warn(`YooKassa payment ${providerPaymentId} (method ${paymentObject.payment_method?.type ?? 'unknown'}) succeeded but no saved bank-card token was verified; the ${payment.planId} subscription for user ${payment.userId} will not renew`);
        }
        const subscription = await tx.subscription.upsert({
          where: { userId: payment.userId },
          create: {
            userId: payment.userId,
            provider: BillingProvider.YOOKASSA,
            planId: payment.planId,
            status: SubscriptionStatus.ACTIVE,
            trialEnd: null,
            currentPeriodEnd: currentEnd,
            cancelAtPeriodEnd,
            providerRef: methodId,
            paymentMethodType: returnedCard?.paymentMethodType ?? null,
            paymentMethodCardType: returnedCard?.paymentMethodCardType ?? null,
            paymentMethodLast4: returnedCard?.paymentMethodLast4 ?? null,
            paymentMethodExpiryMonth: returnedCard?.paymentMethodExpiryMonth ?? null,
            paymentMethodExpiryYear: returnedCard?.paymentMethodExpiryYear ?? null,
            autoRenewConsentAt: payment.autoRenewConsentAt,
            autoRenewConsentText: payment.autoRenewConsentText,
          },
          update: {
            provider: BillingProvider.YOOKASSA,
            planId: payment.planId,
            status: SubscriptionStatus.ACTIVE,
            trialEnd: null,
            currentPeriodEnd: currentEnd,
            cancelAtPeriodEnd,
            providerRef: methodId,
            paymentMethodRevision: { increment: 1 },
            paymentMethodType: returnedCard?.paymentMethodType ?? null,
            paymentMethodCardType: returnedCard?.paymentMethodCardType ?? null,
            paymentMethodLast4: returnedCard?.paymentMethodLast4 ?? null,
            paymentMethodExpiryMonth: returnedCard?.paymentMethodExpiryMonth ?? null,
            paymentMethodExpiryYear: returnedCard?.paymentMethodExpiryYear ?? null,
            providerCustomerRef: null,
            autoRenewConsentAt: payment.autoRenewConsentAt ?? existingSubscription?.autoRenewConsentAt,
            autoRenewConsentText: payment.autoRenewConsentText ?? existingSubscription?.autoRenewConsentText,
            retryCount: 0,
            nextRetryAt: null,
          },
        });
        await tx.payment.update({ where: { id: payment.id }, data: { subscriptionId: subscription.id } });
        return 'applied' as const;
      });
      if (result === 'subscription-mismatch') {
        this.logger.error(`YooKassa charged payment ${payment.id}, but its original subscription is no longer current/eligible; access was not reassigned and manual reconciliation is required`);
      }
      return;
    }

    if (eventType === 'payment.canceled' && paymentObject.status === 'canceled' && payment.status === PaymentStatus.PENDING) {
      // Claim the local payment atomically. A second, differently-ID'd webhook
      // for the same provider payment must not increment retryCount twice.
      const failedClaim = await this.prisma.payment.updateMany({
        where: { id: payment.id, provider: BillingProvider.YOOKASSA, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELED, providerPaymentId },
      });
      if (failedClaim.count !== 1) return;

      if (payment.purpose === PaymentPurpose.RENEWAL || payment.purpose === PaymentPurpose.RETRY) {
        // Renewal failure belongs to the subscription referenced by this exact
        // charge, never merely to the user's latest subscription. Otherwise a
        // delayed failure event could cancel/retry a later purchase.
        if (!payment.subscriptionId) {
          this.logger.error(`Canceled renewal payment ${payment.id} has no subscription mapping; manual reconciliation is required`);
          return;
        }
        const sub = await this.prisma.subscription.findUnique({ where: { id: payment.subscriptionId } });
        const now = new Date();
        const eligible = Boolean(
          sub
          && sub.userId === payment.userId
          && sub.provider === BillingProvider.YOOKASSA
          && sub.planId === payment.planId
          && !sub.cancelAtPeriodEnd
          && sub.currentPeriodEnd
          && sub.currentPeriodEnd <= now
          && (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.PAST_DUE),
        );
        if (!sub || !eligible) {
          this.logger.warn(`Ignoring retry-state update for canceled payment ${payment.id}: its original subscription is no longer eligible`);
          return;
        }

        const nextRetryCount = sub.retryCount + 1;
        const where = {
          id: sub.id,
          userId: payment.userId,
          provider: BillingProvider.YOOKASSA,
          planId: payment.planId,
          retryCount: sub.retryCount,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: { lte: now },
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        };
        if (nextRetryCount >= 4) {
          const changed = await this.prisma.subscription.updateMany({
            where,
            data: { status: SubscriptionStatus.CANCELED, nextRetryAt: null, retryCount: nextRetryCount },
          });
          if (changed.count !== 1) this.logger.warn(`Subscription ${sub.id} changed while its failed charge was processed; retry state was not overwritten`);
        } else {
          // Retry on day 1, then day 3, then day 5 from the initial failure.
          const retryDays = nextRetryCount === 1 ? 1 : 2;
          const changed = await this.prisma.subscription.updateMany({
            where,
            data: {
              status: SubscriptionStatus.PAST_DUE,
              nextRetryAt: new Date(now.getTime() + retryDays * 24 * 60 * 60 * 1000),
              retryCount: nextRetryCount,
            },
          });
          if (changed.count !== 1) this.logger.warn(`Subscription ${sub.id} changed while its failed charge was processed; retry state was not overwritten`);
        }
      }
    }
  }

  /**
   * Pending checkouts older than STALE_CHECKOUT_MS: YooKassa ones are re-fetched and
   * applied if paid or canceled; anything still unresolved (and every Creem one, which
   * gets no webhook when abandoned) is marked CANCELED with supersededAt.
   * Runs from the worker for everyone and before each checkout for that user.
   */
  async expireStaleCheckouts(now = new Date(), userId?: string): Promise<number> {
    const stale = await this.prisma.payment.findMany({
      where: {
        purpose: PaymentPurpose.CHECKOUT,
        status: PaymentStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - STALE_CHECKOUT_MS) },
        ...(userId ? { userId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let expired = 0;
    for (const payment of stale) {
      try {
        if (payment.provider === BillingProvider.YOOKASSA && payment.providerPaymentId) {
          const providerPayment = await this.fetchYooKassaPayment(payment.providerPaymentId);
          if (providerPayment.status === 'succeeded' || providerPayment.status === 'canceled') {
            await this.applyYooKassaEvent(`payment.${providerPayment.status}`, providerPayment);
            continue;
          }
        }
        const result = await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.CANCELED, supersededAt: now },
        });
        expired += result.count;
      } catch (error) {
        // Leave it pending; the next sweep retries the provider check.
        this.logger.warn(`Could not resolve stale checkout ${payment.id}: ${this.errorMessage(error)}`);
      }
    }
    if (expired > 0) this.logger.log(`Expired ${expired} stale pending checkout(s)`);
    return expired;
  }

  async runRecurringBillingBatch(): Promise<{ attempted: number; reminders: number; expiredCheckouts: number }> {
    const now = new Date();
    let attempted = 0;
    let reminders = 0;
    const expiredCheckouts = await this.expireStaleCheckouts(now);
    reminders += await this.sendTrialReminders(now);
    await this.expireScheduledCancellations(now);
    await this.expireYooKassaRetryWindows(now);

    const dueSubscriptions = await this.prisma.subscription.findMany({
      where: {
        provider: BillingProvider.YOOKASSA,
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lte: now },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        providerRef: { not: null },
      },
      include: { user: true, plan: true },
      take: 50,
      orderBy: { currentPeriodEnd: 'asc' },
    });
    for (const subscription of dueSubscriptions) {
      const result = await this.createRecurringCharge(subscription.userId, subscription.id, PaymentPurpose.RENEWAL).catch(async (error) => {
        this.logger.error(`Renewal attempt failed for subscription ${subscription.id}: ${this.errorMessage(error)}`);
        await this.handleRecurringChargeStartFailure(subscription.id, subscription.retryCount, error);
        return false;
      });
      if (result) attempted += 1;
    }

    const retrySubscriptions = await this.prisma.subscription.findMany({
      where: {
        provider: BillingProvider.YOOKASSA,
        status: SubscriptionStatus.PAST_DUE,
        cancelAtPeriodEnd: false,
        nextRetryAt: { lte: now },
        providerRef: { not: null },
      },
      take: 50,
      orderBy: { nextRetryAt: 'asc' },
    });
    for (const subscription of retrySubscriptions) {
      const result = await this.createRecurringCharge(subscription.userId, subscription.id, PaymentPurpose.RETRY).catch(async (error) => {
        this.logger.error(`Retry attempt failed for subscription ${subscription.id}: ${this.errorMessage(error)}`);
        await this.handleRecurringChargeStartFailure(subscription.id, subscription.retryCount, error);
        return false;
      });
      if (result) attempted += 1;
    }
    return { attempted, reminders, expiredCheckouts };
  }

  private async handleRecurringChargeStartFailure(subscriptionId: string, expectedRetryCount: number, error: unknown): Promise<void> {
    if (error instanceof ProviderHttpException && error.isDefinitivePaymentRejection) {
      await this.recordDefinitiveChargeFailure(subscriptionId, expectedRetryCount);
      return;
    }
    // If the response is ambiguous (timeout, 5xx, 408/409/429), retain the
    // pending payment and its idempotency key. The next run replays that same
    // request rather than risking a second charge.
    await this.deferUncertainRenewal(subscriptionId, expectedRetryCount);
  }

  private async recordDefinitiveChargeFailure(subscriptionId: string, expectedRetryCount: number): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        retryCount: expectedRetryCount,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lte: new Date() },
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      },
      select: { id: true, retryCount: true },
    });
    if (!subscription || subscription.retryCount !== expectedRetryCount) return;
    const pendingPayment = await this.prisma.payment.findFirst({
      where: {
        subscriptionId,
        provider: BillingProvider.YOOKASSA,
        status: PaymentStatus.PENDING,
        purpose: { in: [PaymentPurpose.RENEWAL, PaymentPurpose.RETRY] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (pendingPayment) {
      await this.prisma.payment.updateMany({
        where: { id: pendingPayment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
    }

    const nextRetryCount = subscription.retryCount + 1;
    if (nextRetryCount >= 4) {
      await this.prisma.subscription.updateMany({
        where: { id: subscriptionId, retryCount: expectedRetryCount, cancelAtPeriodEnd: false, currentPeriodEnd: { lte: new Date() } },
        data: { status: SubscriptionStatus.CANCELED, nextRetryAt: null, retryCount: nextRetryCount },
      });
      return;
    }
    const retryDays = nextRetryCount === 1 ? 1 : 2;
    await this.prisma.subscription.updateMany({
      where: { id: subscriptionId, retryCount: expectedRetryCount, cancelAtPeriodEnd: false, currentPeriodEnd: { lte: new Date() } },
      data: {
        status: SubscriptionStatus.PAST_DUE,
        nextRetryAt: new Date(Date.now() + retryDays * 24 * 60 * 60 * 1000),
        retryCount: nextRetryCount,
      },
    });
  }

  private async deferUncertainRenewal(subscriptionId: string, expectedRetryCount: number): Promise<void> {
    const now = new Date();
    const nextRetryAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await this.prisma.subscription.updateMany({
      where: {
        id: subscriptionId,
        provider: BillingProvider.YOOKASSA,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        cancelAtPeriodEnd: false,
        retryCount: expectedRetryCount,
        currentPeriodEnd: { lte: now },
      },
      data: {
        status: SubscriptionStatus.PAST_DUE,
        nextRetryAt,
      },
    });
  }


  private async expireYooKassaRetryWindows(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - YOOKASSA_RETRY_GRACE_MS);
    const expired = await this.prisma.subscription.findMany({
      where: {
        provider: BillingProvider.YOOKASSA,
        status: SubscriptionStatus.PAST_DUE,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lte: cutoff },
      },
      select: { id: true },
      take: 100,
    });

    for (const subscription of expired) {
      // Do not close an ambiguous payment. It must be reconciled with YooKassa
      // first, or a late success could be hidden while a new checkout starts.
      const pendingPayment = await this.prisma.payment.findFirst({
        where: {
          subscriptionId: subscription.id,
          provider: BillingProvider.YOOKASSA,
          status: PaymentStatus.PENDING,
          purpose: { in: [PaymentPurpose.RENEWAL, PaymentPurpose.RETRY] },
        },
        select: { id: true },
      });
      if (pendingPayment) continue;

      const changed = await this.prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          provider: BillingProvider.YOOKASSA,
          status: SubscriptionStatus.PAST_DUE,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: { lte: cutoff },
        },
        data: { status: SubscriptionStatus.CANCELED, nextRetryAt: null },
      });
      if (changed.count === 1) {
        this.logger.log(`Closed expired YooKassa retry window for subscription ${subscription.id}`);
      }
    }
  }

  private async expireScheduledCancellations(now: Date): Promise<void> {
    const result = await this.prisma.subscription.updateMany({
      where: {
        cancelAtPeriodEnd: true,
        status: { not: SubscriptionStatus.CANCELED },
        currentPeriodEnd: { lte: now },
      },
      data: { status: SubscriptionStatus.CANCELED, nextRetryAt: null },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} subscriptions whose scheduled cancellation reached period end`);
    }
  }

  private async createRecurringCharge(
    userId: string,
    subscriptionId: string,
    purpose: typeof PaymentPurpose.RENEWAL | typeof PaymentPurpose.RETRY,
  ): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { user: true, plan: true } });
    if (!sub || !sub.providerRef || sub.cancelAtPeriodEnd || !sub.plan.isRecurring || sub.plan.interval === PlanInterval.LIFETIME) return false;
    if (sub.plan.priceRub === null || sub.plan.priceRub <= 0) {
      throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'A valid RUB price is required before recurring charges can run' });
    }
    const shopId = this.config.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.config.get<string>('YOOKASSA_SECRET_KEY');
    if (!shopId || !secretKey) {
      throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa is not configured for recurring charges' });
    }
    const vatCode = this.config.get<string>('YOOKASSA_RECEIPT_VAT_CODE');
    if (!vatCode && this.config.get<string>('NODE_ENV') === 'production') {
      throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa receipt VAT code must be configured before recurring charges' });
    }
    const periodKey = (sub.currentPeriodEnd ?? new Date()).toISOString();
    let effectivePurpose = purpose;
    let idempotencyKey = recurringChargeIdempotencyKey(sub.id, periodKey, effectivePurpose, sub.retryCount);
    let payment = await this.prisma.payment.findUnique({ where: { idempotencyKey } });
    // If the original renewal request had an ambiguous network outcome, retry
    // that exact request (same body/Idempotence-Key) before creating a distinct
    // retry attempt. This prevents a delayed response from causing a double charge.
    if (!payment && purpose === PaymentPurpose.RETRY) {
      const uncertainRenewal = await this.prisma.payment.findFirst({
        where: {
          subscriptionId: sub.id,
          purpose: PaymentPurpose.RENEWAL,
          status: PaymentStatus.PENDING,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (uncertainRenewal) {
        if (!uncertainRenewal.idempotencyKey) {
          this.logger.error(`Pending renewal payment ${uncertainRenewal.id} has no idempotency key; refusing to risk a duplicate charge`);
          throw new ServiceUnavailableException({
            code: 'internal',
            message: 'A previous renewal attempt requires manual reconciliation before retrying',
          });
        }
        payment = uncertainRenewal;
        effectivePurpose = PaymentPurpose.RENEWAL;
        idempotencyKey = uncertainRenewal.idempotencyKey;
      }
    }
    if (payment?.providerPaymentId) {
      if (payment.status !== PaymentStatus.PENDING) return false;
      // Webhooks are expected, but reconciling the existing provider payment
      // protects us if a webhook is delayed or lost. Never create a new charge
      // while an earlier one has a provider ID and unresolved status.
      const providerPayment = await this.fetchYooKassaPayment(payment.providerPaymentId);
      if (providerPayment.id !== payment.providerPaymentId) {
        throw new BadGatewayException({ code: 'internal', message: 'YooKassa returned a mismatched payment ID' });
      }
      if (providerPayment.status === 'succeeded') {
        await this.applyYooKassaEvent('payment.succeeded', providerPayment);
      } else if (providerPayment.status === 'canceled') {
        await this.applyYooKassaEvent('payment.canceled', providerPayment);
      } else {
        await this.deferPendingProviderPayment(sub.id, payment.id);
      }
      return false;
    }
    if (payment && payment.status !== PaymentStatus.PENDING) return false;
    let createdPaymentThisRun = false;
    if (!payment) {
      payment = await this.prisma.payment.create({
        data: {
          userId,
          subscriptionId,
          planId: sub.planId,
          provider: BillingProvider.YOOKASSA,
          amount: sub.plan.priceRub,
          currency: 'RUB',
          status: PaymentStatus.PENDING,
          purpose: effectivePurpose,
          idempotencyKey,
          autoRenewConsentAt: sub.autoRenewConsentAt,
          autoRenewConsentText: sub.autoRenewConsentText,
        },
      });
      createdPaymentThisRun = true;
    }

    // Claim eligibility against the current subscription row after reserving the
    // pending Payment. The update locks/re-checks that row: if unlinking won the
    // race, no stale payment_method_id is sent; if this claim wins, unlink sees
    // the committed pending renewal and refuses to report success until it settles.
    const claimAt = new Date();
    const claim = await this.prisma.subscription.updateMany({
      where: {
        id: sub.id,
        provider: BillingProvider.YOOKASSA,
        providerRef: sub.providerRef,
        paymentMethodRevision: sub.paymentMethodRevision,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lte: claimAt },
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      },
      data: { paymentMethodRevision: { increment: 1 } },
    });
    if (claim.count !== 1) {
      if (createdPaymentThisRun) {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING, providerPaymentId: null },
          data: { status: PaymentStatus.CANCELED, supersededAt: claimAt },
        });
      }
      return false;
    }

    const amount = (sub.plan.priceRub / 100).toFixed(2);
    const planNames = this.asRecord(sub.plan.names);
    const name = String(planNames[sub.user.locale] ?? planNames.en ?? sub.plan.id).slice(0, 128);
    const receipt = vatCode ? {
      customer: { email: sub.user.email },
      items: [{ description: name, quantity: '1.00', amount: { value: amount, currency: 'RUB' }, vat_code: Number(vatCode), payment_mode: 'full_prepayment', payment_subject: 'service' }],
      ...(this.config.get<string>('YOOKASSA_TAX_SYSTEM_CODE') ? { tax_system_code: Number(this.config.get<string>('YOOKASSA_TAX_SYSTEM_CODE')) } : {}),
    } : undefined;
    const base = this.config.get<string>('YOOKASSA_API_BASE_URL', 'https://api.yookassa.ru/v3');
    const response = await this.providerRequest(`${base}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotencyKey,
      },
      body: JSON.stringify({
        amount: { value: amount, currency: 'RUB' },
        capture: true,
        payment_method_id: sub.providerRef,
        description: `ColorPicker renewal — ${name}`.slice(0, 128),
        metadata: { userId, planId: sub.planId, paymentId: payment.id, subscriptionId: sub.id, purpose: effectivePurpose },
        ...(receipt ? { receipt } : {}),
      }),
    });
    await this.prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentId: typeof response.id === 'string' ? response.id : null } });
    await this.deferPendingProviderPayment(sub.id, payment.id);
    return true;
  }

  private async deferPendingProviderPayment(subscriptionId: string, paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, providerPaymentId: true, subscriptionId: true },
    });
    if (
      !payment
      || payment.status !== PaymentStatus.PENDING
      || !payment.providerPaymentId
      || payment.subscriptionId !== subscriptionId
    ) return;
    const now = new Date();
    await this.prisma.subscription.updateMany({
      where: {
        id: subscriptionId,
        provider: BillingProvider.YOOKASSA,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { lte: now },
      },
      data: {
        status: SubscriptionStatus.PAST_DUE,
        nextRetryAt: new Date(now.getTime() + 30 * 60 * 1000),
      },
    });
  }

  private async sendTrialReminders(now: Date): Promise<number> {
    const twoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const due = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.TRIALING,
        trialEnd: { gt: now, lte: twoDays },
        trialReminderSentAt: null,
      },
      include: { user: true },
      take: 100,
    });
    let sent = 0;
    for (const subscription of due) {
      try {
        await this.mail.sendTrialReminder({ to: subscription.user.email, locale: subscription.user.locale, trialEnd: subscription.trialEnd! });
        const result = await this.prisma.subscription.updateMany({
          where: { id: subscription.id, trialReminderSentAt: null },
          data: { trialReminderSentAt: new Date() },
        });
        sent += result.count;
      } catch (error) {
        this.logger.warn(`Trial reminder for subscription ${subscription.id} was not sent: ${this.errorMessage(error)}`);
      }
    }
    return sent;
  }

  private async getPaymentAmount(paymentId: string): Promise<number> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { amount: true } });
    if (!payment) throw new NotFoundException({ code: 'not_found', message: 'Local payment record not found' });
    return payment.amount;
  }

  private async fetchCreemTransaction(transactionId: string): Promise<ProviderPayment> {
    const apiKey = this.config.get<string>('CREEM_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'Creem is not configured for refund verification' });
    const base = this.config.get<string>('CREEM_API_BASE_URL', this.config.get<string>('NODE_ENV') === 'production' ? 'https://api.creem.io' : 'https://test-api.creem.io');
    return this.providerRequest(`${base}/v1/transactions?transaction_id=${encodeURIComponent(transactionId)}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
  }

  private async fetchYooKassaPayment(paymentId: string): Promise<ProviderPayment> {
    const shopId = this.config.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.config.get<string>('YOOKASSA_SECRET_KEY');
    if (!shopId || !secretKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa is not configured for webhook verification' });
    const base = this.config.get<string>('YOOKASSA_API_BASE_URL', 'https://api.yookassa.ru/v3');
    return this.providerRequest(`${base}/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}` },
    });
  }

  private async fetchYooKassaRefund(refundId: string): Promise<ProviderPayment> {
    const shopId = this.config.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.config.get<string>('YOOKASSA_SECRET_KEY');
    if (!shopId || !secretKey) throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa is not configured for refund verification' });
    const base = this.config.get<string>('YOOKASSA_API_BASE_URL', 'https://api.yookassa.ru/v3');
    return this.providerRequest(`${base}/refunds/${encodeURIComponent(refundId)}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}` },
    });
  }

  private async beginEvent(provider: BillingProvider, eventId: string, eventType: string, payload: Record<string, unknown>) {
    const now = new Date();
    const staleLease = new Date(now.getTime() - 2 * 60_000);
    const claimExisting = async (id: string) => {
      const claim = await this.prisma.paymentEvent.updateMany({
        where: {
          id,
          processedAt: null,
          OR: [{ processingAt: null }, { processingAt: { lt: staleLease } }],
        },
        data: { processingAt: now, processingError: null },
      });
      if (claim.count === 1) return { id, shouldProcess: true, alreadyProcessed: false };
      const current = await this.prisma.paymentEvent.findUnique({ where: { id }, select: { processedAt: true } });
      return { id, shouldProcess: false, alreadyProcessed: Boolean(current?.processedAt) };
    };

    const existing = await this.prisma.paymentEvent.findUnique({ where: { provider_providerEventId: { provider, providerEventId: eventId } } });
    if (existing?.processedAt) return { id: existing.id, shouldProcess: false, alreadyProcessed: true };
    if (existing) return claimExisting(existing.id);
    try {
      const created = await this.prisma.paymentEvent.create({
        data: {
          provider, providerEventId: eventId, eventType,
          rawPayload: payload as Prisma.InputJsonValue,
          processingAt: now,
        },
      });
      return { id: created.id, shouldProcess: true, alreadyProcessed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.paymentEvent.findUnique({ where: { provider_providerEventId: { provider, providerEventId: eventId } } });
        if (raced?.processedAt) return { id: raced.id, shouldProcess: false, alreadyProcessed: true };
        if (raced) return claimExisting(raced.id);
      }
      throw error;
    }
  }

  private validCreemSignature(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const supplied = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(supplied, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private assertYooKassaIp(remoteIp: string): void {
    const trusted = (this.config.get<string>('YOOKASSA_TRUSTED_IPS') ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    if (!trusted.length) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        this.logger.warn(`Rejected YooKassa webhook from ${remoteIp}: YOOKASSA_TRUSTED_IPS is empty`);
        throw new ServiceUnavailableException({ code: 'billing_not_configured', message: 'YooKassa trusted IP allowlist must be configured in production' });
      }
      return;
    }
    if (!isIpAllowed(remoteIp, trusted)) {
      // With a wrong TRUST_PROXY_HOPS this shows the proxy's address instead of YooKassa's.
      this.logger.warn(`Rejected YooKassa webhook from ${remoteIp}: not in YOOKASSA_TRUSTED_IPS`);
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Webhook source IP is not allowed' });
    }
  }

  private async providerRequest(url: string, init: RequestInit): Promise<ProviderPayment> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      this.logger.error(`Payment provider request failed: ${this.errorMessage(error)}`);
      throw new BadGatewayException({ code: 'internal', message: 'Payment provider is unavailable' });
    }
    const responseText = await response.text();
    let body: ProviderPayment & { message?: string; error?: string } = {};
    try { body = responseText ? JSON.parse(responseText) as typeof body : {}; } catch { /* provider may return a non-JSON error */ }
    if (!response.ok) {
      this.logger.warn(`Payment provider responded ${response.status}: ${String(body.message ?? body.error ?? responseText).slice(0, 500)}`);
      const method = (init.method ?? 'GET').toUpperCase();
      let paymentCreateRequest = false;
      try {
        paymentCreateRequest = method === 'POST' && /\/(?:payments|checkouts)\/?$/.test(new URL(url).pathname);
      } catch { /* malformed base URLs are reported as provider failures, never classified as definite */ }
      throw new ProviderHttpException(response.status, paymentCreateRequest);
    }
    return body;
  }

  private successUrl(): string {
    const origin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
    return `${origin}/billing/success`;
  }

  private publicSubscription(subscription: {
    status: SubscriptionStatus;
    provider: BillingProvider;
    planId: string;
    trialEnd: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    providerRef: string | null;
    paymentMethodType: string | null;
    paymentMethodCardType: string | null;
    paymentMethodLast4: string | null;
    paymentMethodExpiryMonth: string | null;
    paymentMethodExpiryYear: string | null;
  }) {
    return {
      status: subscription.status.toLowerCase(),
      provider: subscription.provider.toLowerCase(),
      planId: subscription.planId,
      trialEnd: subscription.trialEnd?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      hasPaymentMethod: hasSavedPaymentMethod(subscription),
      paymentMethod: toPublicPaymentMethod(subscription),
    };
  }


  private parseProviderDate(value: unknown): Date | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value > 10_000_000_000 ? value : value * 1000;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string' && value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  private extractProviderData(payload: Record<string, unknown>): Record<string, unknown> {
    const data = payload['object'] ?? payload['data'];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return payload;
    const nested = data as Record<string, unknown>;
    const inner = nested['object'];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : nested;
  }

  private extractMetadata(data: Record<string, unknown>): Record<string, unknown> {
    const metadata = data['metadata'];
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  }

  private findNestedId(payload: Record<string, unknown>): string {
    const data = this.extractProviderData(payload);
    return this.stringValue(data['id'] ?? data['subscription_id']) ?? 'unknown';
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
