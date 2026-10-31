import { request } from 'node:http';
import { afterEach } from 'vitest';
import { startTargets, type RunningTargets } from '../../src/chaos/targets/server.js';
import { ManualClock } from '../../src/time/clock.js';

export const START_MS = 1_761_912_345_678;

const running: RunningTargets[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((targets) => targets.close()));
});

export async function targetsOnManualClock(options: { honourIdempotencyKey?: boolean } = {}): Promise<{ clock: ManualClock; targets: RunningTargets }> {
  const clock = new ManualClock(START_MS);
  const targets = await startTargets({ clock, ...options });
  running.push(targets);
  return { clock, targets };
}

export interface HttpReply {
  status: number;
  body: string;
}

export function send(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpReply> {
  return send(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
}

export function postForm(url: string, fields: Record<string, string>): Promise<HttpReply> {
  return send(url, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

export function pageText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
    if (match[1] !== undefined) fields[match[1]] = match[2] ?? '';
  }
  for (const match of html.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([^<]*)<\/textarea>/g)) {
    if (match[1] !== undefined) fields[match[1]] = match[2] ?? '';
  }
  return fields;
}
