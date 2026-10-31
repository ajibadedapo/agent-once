export class LedgerUnavailableError extends Error {
  override readonly name: string = 'LedgerUnavailableError';

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`agent-once ledger unavailable: ${reason}`, options);
  }
}

export class LedgerSchemaTooNewError extends LedgerUnavailableError {
  override readonly name: string = 'LedgerSchemaTooNewError';
  readonly found: number;

  constructor(found: number, known: number) {
    super(`schema_version ${found} is newer than the supported version ${known}; upgrade agent-once to open it`);
    this.found = found;
  }
}

export class LedgerConflictError extends Error {
  override readonly name: string = 'LedgerConflictError';
  readonly intentHash: string;
  readonly occurrence: number;

  constructor(intentHash: string, occurrence: number, options?: { cause?: unknown }) {
    super(`occurrence ${occurrence} of intent ${intentHash} is already intended`, options);
    this.intentHash = intentHash;
    this.occurrence = occurrence;
  }
}

export class LedgerUsageError extends Error {
  override readonly name: string = 'LedgerUsageError';
}
