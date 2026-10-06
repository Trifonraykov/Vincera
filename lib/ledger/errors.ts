/**
 * Ledger errors (§9; CLAUDE.md §19.33). Thrown when an input or a stored state would break a
 * ledger invariant; the caller's transaction rolls back, so no partial ledger is ever written.
 * Messages carry ids and amounts only, never emails or tokens.
 */

export type LedgerErrorCode =
  /** An input is not a valid integer amount, rate or split. */
  | "invalid_input"
  /** Lines that must sum to a total do not (a bug: never caught and ignored). */
  | "sum_mismatch"
  /** The order, refund or chargeback to post does not exist. */
  | "not_found"
  /** The order has no collab members (or their splits do not sum to 100). */
  | "invalid_members"
  /** A currency differs from the order's (the platform settles in one currency per order). */
  | "currency_mismatch"
  /** The balance transaction does not belong to the order's charge (amount differs). */
  | "balance_transaction_mismatch"
  /** A refund or chargeback larger than what is left of the order. */
  | "over_refund"
  /** The refund or chargeback is not in a state that may be posted. */
  | "invalid_state"

export class LedgerError extends Error {
  readonly code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = "LedgerError"
    this.code = code
  }
}
