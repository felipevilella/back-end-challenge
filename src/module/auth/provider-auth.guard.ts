import { type CanActivate, Injectable } from '@nestjs/common';
/** Explicit extension point for an external OIDC provider. Authentication is deferred. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
