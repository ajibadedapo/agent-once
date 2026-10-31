import type { Guard } from '../guard/guard.js';
import type { GuardResult, GuardedCall, ToolOutcome } from '../guard/types.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export async function guardedFetch(
  guard: Guard,
  call: Omit<GuardedCall, 'args'> & { args: Record<string, unknown> },
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<GuardResult> {
  return guard.run(call, async ({ actionId }): Promise<ToolOutcome> => {
    const headers = new Headers(init.headers);
    if (actionId !== undefined && !headers.has(IDEMPOTENCY_KEY_HEADER)) headers.set(IDEMPOTENCY_KEY_HEADER, actionId);
    const response = await fetchImpl(input, { ...init, headers });
    const result = { status: response.status, body: await response.text() };
    return response.ok ? { kind: 'ok', result } : { kind: 'error_result', result };
  });
}
