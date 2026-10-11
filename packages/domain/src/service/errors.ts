/** A refusal the service answers with a closed code and a status. Messages, stacks and upstream bodies never leave. */
export class ServiceRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 501 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ServiceRefusal';
  }
}
