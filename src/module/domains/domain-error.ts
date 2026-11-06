export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 422,
  ) {
    super(code);
  }
}
