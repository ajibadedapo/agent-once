import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvidenceEvent, EvidenceSink } from './types.js';

export class JsonlEvidenceSink implements EvidenceSink {
  private directoryReady = false;

  constructor(private readonly path: string) {}

  emit(event: EvidenceEvent): void {
    if (!this.directoryReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.directoryReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
