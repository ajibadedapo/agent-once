import type { EvidenceEvent, EvidenceSink } from './types.js';

export class FanoutEvidenceSink implements EvidenceSink {
  constructor(private readonly sinks: readonly EvidenceSink[]) {}

  emit(event: EvidenceEvent): void {
    const failures: unknown[] = [];
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} evidence sink(s) failed`);
  }
}
