// A DomainError is a rule the system refuses to break. Its message is plain Arabic
// shown as-is to the user and returned as-is to the AI.
export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const fail = (msg: string, status = 400): never => {
  throw new DomainError(msg, status);
};
