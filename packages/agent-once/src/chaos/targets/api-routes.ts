import type { IncomingMessage, ServerResponse } from 'node:http';
import { TARGETS, type TargetName } from './catalog.js';
import type { TargetsEngine } from './engine.js';
import { dropConnection, idempotencyKeyOf, readBody, sendJson } from './http-io.js';

export const STALE_FORM_ERROR = 'stale form: nothing was submitted';

type FieldsResult = { fields: Record<string, string> } | { error: string };

function apiFields(target: TargetName, body: string): FieldsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'the body is not a JSON object' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'the body is not a JSON object' };
  const values = parsed as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const field of TARGETS[target].fields) {
    const value = values[field.name];
    if (typeof value === 'string' && value !== '') fields[field.name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) fields[field.name] = String(value);
    else return { error: `missing field ${field.name}` };
  }
  return { fields };
}

export async function handleApi(engine: TargetsEngine, target: TargetName, request: IncomingMessage, response: ServerResponse, arrivalMs: number): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, 200, engine.list(target));
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const parsed = apiFields(target, await readBody(request));
  if ('error' in parsed) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  const outcome = engine.mutate({ target, fields: parsed.fields, clientRef: idempotencyKeyOf(request), arrivalMs });
  switch (outcome.kind) {
    case 'committed':
      sendJson(response, outcome.commit.duplicate ? 200 : 201, outcome.commit.effect);
      return;
    case 'stale':
      sendJson(response, 409, { error: STALE_FORM_ERROR });
      return;
    case 'dropped':
      dropConnection(request);
      return;
  }
}
