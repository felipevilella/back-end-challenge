import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          endpoint: process.env.SQS_ENDPOINT,
        }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule {}
