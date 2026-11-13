import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BillingService } from './billing.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly billing: BillingService) {}

  @Post('creem')
  @HttpCode(HttpStatus.OK)
  creem(
    @Req() request: RawBodyRequest,
    @Headers('creem-signature') signature: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.billing.handleCreemWebhook(
      request.rawBody ?? Buffer.from(JSON.stringify(payload ?? {})),
      signature,
      payload ?? {},
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
    );
  }

  @Post('yookassa')
  @HttpCode(HttpStatus.OK)
  yookassa(@Req() request: Request, @Body() payload: Record<string, unknown>) {
    return this.billing.handleYooKassaWebhook(payload ?? {}, request.ip ?? request.socket.remoteAddress ?? 'unknown');
  }
}
