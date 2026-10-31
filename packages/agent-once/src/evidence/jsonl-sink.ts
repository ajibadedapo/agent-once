import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRIVATE_FILE_MODE, ensurePrivateDirectory } from '../private-files.js';
import type { EvidenceEvent, EvidenceSink } from './types.js';

export class JsonlEvidenceSink implements EvidenceSink {
  private directoryReady = false;

  constructor(private readonly path: string) {}

  emit(event: EvidenceEvent): void {
    if (!this.directoryReady) {
      ensurePrivateDirectory(dirname(this.path));
      this.directoryReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  }
}
