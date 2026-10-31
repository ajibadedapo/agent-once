import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FanoutEvidenceSink } from '../src/evidence/fanout-sink.js';
import { JsonlEvidenceSink } from '../src/evidence/jsonl-sink.js';
import { OtelEvidenceSink, type OtelTraceApi } from '../src/evidence/otel-sink.js';
import type { EvidenceEvent } from '../src/evidence/types.js';
import { RecordingSink, START_MS } from './guard-harness.js';

const event = (overrides: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
  v: 1,
  atMs: START_MS,
  kind: 'decision',
  actionId: 'ao_000000000000000000000001',
  tool: 'place_order',
  sessionKey: 'client:/work',
  detail: { decision: 'execute', reason: 'new', occurrence: 0 },
  ...overrides,
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('JsonlEvidenceSink', () => {
  test('appends one JSON line per event with v 1, creating the directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-once-evidence-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'events.jsonl');
    const sink = new JsonlEvidenceSink(path);
    sink.emit(event());
    sink.emit(event({ kind: 'state', detail: { state: 'intended', occurrence: 0 } }));
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines.slice(0, 2).map((line) => JSON.parse(line) as EvidenceEvent)).toEqual([
      event(),
      event({ kind: 'state', detail: { state: 'intended', occurrence: 0 } }),
    ]);
    expect(lines.slice(0, 2).every((line) => line.startsWith('{"v":1,'))).toBe(true);
  });
});

describe('FanoutEvidenceSink', () => {
  test('delivers to every sink and reports failures after delivering to the rest', () => {
    const first = new RecordingSink();
    const last = new RecordingSink();
    const broken = {
      emit: () => {
        throw new Error('broken sink');
      },
    };
    const sink = new FanoutEvidenceSink([first, broken, last]);
    expect(() => sink.emit(event())).toThrow(AggregateError);
    expect(first.events).toEqual([event()]);
    expect(last.events).toEqual([event()]);
  });
});

describe('OtelEvidenceSink', () => {
  test('adds a span event with flattened attributes to the active span', () => {
    const recorded: Array<{ name: string; attributes: Record<string, string | number | boolean> }> = [];
    const api: OtelTraceApi = {
      trace: {
        getActiveSpan: () => ({
          addEvent: (name, attributes) => {
            recorded.push({ name, attributes });
          },
        }),
      },
    };
    new OtelEvidenceSink(api).emit(event({ detail: { decision: 'execute', occurrence: 0, extra: { nested: true } } }));
    expect(recorded).toEqual([
      {
        name: 'agent_once.decision',
        attributes: {
          'agent_once.v': 1,
          'agent_once.at_ms': START_MS,
          'agent_once.action_id': 'ao_000000000000000000000001',
          'agent_once.tool': 'place_order',
          'agent_once.session_key': 'client:/work',
          'agent_once.decision': 'execute',
          'agent_once.occurrence': 0,
          'agent_once.extra': '{"nested":true}',
        },
      },
    ]);
  });

  test('is a no-op without an active span', () => {
    const api: OtelTraceApi = { trace: { getActiveSpan: () => undefined } };
    expect(() => new OtelEvidenceSink(api).emit(event())).not.toThrow();
  });

  test('is a no-op when the OpenTelemetry API cannot be imported', async () => {
    const sink = await OtelEvidenceSink.create(async () => {
      throw new Error('Cannot find package @opentelemetry/api');
    });
    expect(sink.active).toBe(false);
    expect(() => sink.emit(event())).not.toThrow();
  });

  test('create uses the imported API when it loads', async () => {
    const api: OtelTraceApi = { trace: { getActiveSpan: () => undefined } };
    const sink = await OtelEvidenceSink.create(async () => api);
    expect(sink.active).toBe(true);
  });

  test('create without a loader falls back to a no-op when the package is absent', async () => {
    const sink = await OtelEvidenceSink.create();
    expect(() => sink.emit(event())).not.toThrow();
  });
});
