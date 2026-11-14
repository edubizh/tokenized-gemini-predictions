/** The login token is missing or does not verify. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
