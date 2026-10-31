import type { IncomingMessage, ServerResponse } from 'node:http';
import { STALE_FORM_ERROR } from './api-routes.js';
import { TARGET_NAMES, TARGETS, type TargetName, type TargetSpec } from './catalog.js';
import type { TargetsEngine } from './engine.js';
import { dropConnection, idempotencyKeyOf, readBody, sendHtml } from './http-io.js';

const REFERENCE_FIELD = 'reference';
const REFERENCE_PATTERN = /^F-\d+$/;

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function elementName(field: string, generation: number): string {
  return generation === 1 ? field : `${field}_v${generation}`;
}

function formHtml(spec: TargetSpec, reference: string, generation: number): string {
  const inputs = spec.fields.map((field) => {
    const name = elementName(field.name, generation);
    const id = `${spec.name}-${name}`;
    const control = field.multiline
      ? `<textarea id="${id}" name="${name}">${escapeHtml(field.example)}</textarea>`
      : `<input id="${id}" name="${name}" value="${escapeHtml(field.example)}">`;
    return `<p><label for="${id}">${escapeHtml(field.label)}</label> ${control}</p>`;
  });
  return [
    `<h1>${escapeHtml(spec.title)}</h1>`,
    `<p>Reference ${reference}</p>`,
    `<form method="post" action="/${spec.name}/submit">`,
    `<input type="hidden" name="${REFERENCE_FIELD}" value="${reference}">`,
    ...inputs,
    `<p><button type="submit">${escapeHtml(spec.button)}</button></p>`,
    '</form>',
  ].join('\n');
}

function renderForm(engine: TargetsEngine, spec: TargetSpec, notice?: string): string {
  const form = formHtml(spec, engine.issueReference(), engine.generation(spec.name));
  return page(spec.title, notice === undefined ? form : `<p role="alert">${escapeHtml(notice)}</p>\n${form}`);
}

function submittedValue(values: URLSearchParams, field: string): string | undefined {
  const pattern = new RegExp(`^${field}(?:_v\\d+)?$`);
  for (const [name, value] of values) {
    if (pattern.test(name) && value !== '') return value;
  }
  return undefined;
}

type SubmissionResult = { fields: Record<string, string> } | { error: string };

function submission(spec: TargetSpec, body: string): SubmissionResult {
  const values = new URLSearchParams(body);
  const fields: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = submittedValue(values, field.name);
    if (value === undefined) return { error: `missing field ${field.name}` };
    fields[field.name] = value;
  }
  const reference = values.get(REFERENCE_FIELD);
  if (reference === null || !REFERENCE_PATTERN.test(reference)) return { error: `missing field ${REFERENCE_FIELD}` };
  fields[REFERENCE_FIELD] = reference;
  return { fields };
}

function historyHtml(engine: TargetsEngine, spec: TargetSpec): string {
  const entries = engine
    .list(spec.name)
    .filter((effect) => effect.fields[REFERENCE_FIELD] !== undefined)
    .map((effect) => `<li>${escapeHtml(effect.fields[REFERENCE_FIELD] ?? '')}: ${escapeHtml(spec.historyEntry(effect.id))}</li>`);
  const list = entries.length === 0 ? '<p>No entries yet.</p>' : `<ul>\n${entries.join('\n')}\n</ul>`;
  return page(spec.historyTitle, `<h1>${escapeHtml(spec.historyTitle)}</h1>\n${list}`);
}

export function indexHtml(): string {
  const links = TARGET_NAMES.map((target) => `<li><a href="/${target}">${target}</a>: ${escapeHtml(TARGETS[target].title)}</li>`);
  return page('agent-once chaos targets', `<h1>agent-once chaos targets</h1>\n<ul>\n${links.join('\n')}\n</ul>`);
}

export async function handleUi(
  engine: TargetsEngine,
  target: TargetName,
  action: 'form' | 'submit' | 'history',
  request: IncomingMessage,
  response: ServerResponse,
  arrivalMs: number,
): Promise<void> {
  const spec = TARGETS[target];
  const expected = action === 'submit' ? 'POST' : 'GET';
  if (request.method !== expected) {
    sendHtml(response, 405, page('Method not allowed', '<h1>Method not allowed</h1>'));
    return;
  }
  if (action === 'form') {
    sendHtml(response, 200, renderForm(engine, spec));
    return;
  }
  if (action === 'history') {
    sendHtml(response, 200, historyHtml(engine, spec));
    return;
  }
  const parsed = submission(spec, await readBody(request));
  if ('error' in parsed) {
    sendHtml(response, 400, page(spec.title, `<h1>Not submitted</h1>\n<p>${escapeHtml(parsed.error)}</p>`));
    return;
  }
  const outcome = engine.mutate({ target, fields: parsed.fields, clientRef: idempotencyKeyOf(request), arrivalMs });
  switch (outcome.kind) {
    case 'committed': {
      const { effect } = outcome.commit;
      const reference = effect.fields[REFERENCE_FIELD] ?? '';
      sendHtml(response, 200, page(spec.confirmedHeading, `<h1>${escapeHtml(spec.confirmedHeading)}</h1>\n<p>${escapeHtml(spec.confirmation(effect.id, reference))}</p>`));
      return;
    }
    case 'stale':
      sendHtml(response, 409, renderForm(engine, spec, STALE_FORM_ERROR));
      return;
    case 'dropped':
      dropConnection(request);
      return;
  }
}
