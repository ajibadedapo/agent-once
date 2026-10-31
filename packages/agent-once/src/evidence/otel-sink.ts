import type { EvidenceEvent, EvidenceSink } from './types.js';

type AttributeValue = string | number | boolean;

export interface OtelTraceApi {
  trace: {
    getActiveSpan(): { addEvent(name: string, attributes: Record<string, AttributeValue>): unknown } | undefined;
  };
}

const OTEL_API_PACKAGE = '@opentelemetry/api';
const PREFIX = 'agent_once.';

async function importOtelApi(): Promise<OtelTraceApi> {
  const location = import.meta.resolve(OTEL_API_PACKAGE);
  return (await import(location)) as OtelTraceApi;
}

const MODULE_NOT_FOUND_CODES: ReadonlySet<unknown> = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

function isModuleNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && MODULE_NOT_FOUND_CODES.has(error.code);
}

function toAttribute(value: unknown): AttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

export class OtelEvidenceSink implements EvidenceSink {
  constructor(private readonly api?: OtelTraceApi) {}

  static async create(load: () => Promise<OtelTraceApi> = importOtelApi): Promise<OtelEvidenceSink> {
    try {
      return new OtelEvidenceSink(await load());
    } catch (error) {
      if (isModuleNotFound(error)) return new OtelEvidenceSink();
      throw error;
    }
  }

  get active(): boolean {
    return this.api !== undefined;
  }

  emit(event: EvidenceEvent): void {
    const span = this.api?.trace.getActiveSpan();
    if (span === undefined) return;
    const attributes: Record<string, AttributeValue> = {};
    for (const [key, value] of Object.entries(event.detail)) attributes[`${PREFIX}${key}`] = toAttribute(value);
    attributes[`${PREFIX}v`] = event.v;
    attributes[`${PREFIX}at_ms`] = event.atMs;
    if (event.actionId !== undefined) attributes[`${PREFIX}action_id`] = event.actionId;
    attributes[`${PREFIX}tool`] = event.tool;
    attributes[`${PREFIX}session_key`] = event.sessionKey;
    span.addEvent(`${PREFIX}${event.kind}`, attributes);
  }
}
