import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { DomainError } from '../../module/domains/domain-error';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ErrorResponse>();
    if (error instanceof DomainError) {
      response.status(error.httpStatus).json({ code: error.code });
    } else if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
    } else {
      const code = (
        error as {
          code?: string;
        }
      )?.code;
      const transient =
        [
          '40001',
          '40P01',
          '55P03',
          '53300',
          '57P01',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
        ].includes(code ?? '') || code?.startsWith('08');
      response
        .status(transient ? 503 : 500)
        .json({ code: transient ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INTERNAL_ERROR' });
    }
  }
}
