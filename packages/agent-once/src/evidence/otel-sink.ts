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
  const specifier: string = OTEL_API_PACKAGE;
  return (await import(specifier)) as OtelTraceApi;
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
    } catch {
      return new OtelEvidenceSink();
    }
  }

  get active(): boolean {
    return this.api !== undefined;
  }

  emit(event: EvidenceEvent): void {
    const span = this.api?.trace.getActiveSpan();
    if (span === undefined) return;
    const attributes: Record<string, AttributeValue> = {
      [`${PREFIX}v`]: event.v,
      [`${PREFIX}at_ms`]: event.atMs,
    };
    if (event.actionId !== undefined) attributes[`${PREFIX}action_id`] = event.actionId;
    attributes[`${PREFIX}tool`] = event.tool;
    attributes[`${PREFIX}session_key`] = event.sessionKey;
    for (const [key, value] of Object.entries(event.detail)) attributes[`${PREFIX}${key}`] = toAttribute(value);
    span.addEvent(`${PREFIX}${event.kind}`, attributes);
  }
}
