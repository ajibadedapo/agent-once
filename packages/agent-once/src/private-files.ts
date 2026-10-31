import { closeSync, mkdirSync, openSync } from 'node:fs';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

export function ensurePrivateFile(path: string): void {
  closeSync(openSync(path, 'a', PRIVATE_FILE_MODE));
}
