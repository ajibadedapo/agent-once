import type { JsonValue } from '../canonical/jcs.js';

export type EvidenceKind = 'decision' | 'state' | 'resolve' | 'reconcile';

export interface EvidenceEvent {
  v: 1;
  atMs: number;
  kind: EvidenceKind;
  actionId?: string;
  tool: string;
  sessionKey: string;
  detail: Record<string, JsonValue>;
}

export interface EvidenceSink {
  emit(event: EvidenceEvent): void;
}
