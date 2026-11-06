import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { MoneyDto } from '../../wallets/dto/create-wallet.dto';
import type { WagerKind } from '../../domains/wager-transaction';

export class WagerDto {
  @IsString()
  @Length(1, 128)
  providerId!: string;

  @IsString()
  @Length(1, 256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 256)
  roundId!: string;

  @IsString()
  @Length(1, 256)
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: WagerKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  referenceExternalTransactionId?: string;
}

export class SqsWagerData extends WagerDto {
  @IsString()
  @Length(1, 256)
  idempotencyKey!: string;
}

export class WagerMessageDto {
  @IsString()
  @Length(1, 256)
  messageId!: string;

  @IsIn(['WagerTransactionRequested'])
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => SqsWagerData)
  data!: SqsWagerData;
}
