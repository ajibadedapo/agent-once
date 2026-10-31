import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../../time/clock.js';
import { handleApi } from './api-routes.js';
import { isTargetName, type TargetName } from './catalog.js';
import { TargetsEngine } from './engine.js';
import { FaultPlanError, parseFaultPlan, type FaultPlan } from './faults.js';
import { BodyTooLargeError, readBody, sendHtml, sendJson } from './http-io.js';
import type { Effect } from './store.js';
import { handleUi, indexHtml } from './ui-pages.js';

export interface TargetsOptions {
  clock: Clock;
  port?: number;
  host?: string;
  honourIdempotencyKey?: boolean;
}

export interface RunningTargets {
  url: string;
  setFaults(plan: FaultPlan): void;
  truth(): Record<TargetName, Effect[]>;
  reset(): void;
  pendingCommits(): number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const UI_PATH = /^\/([a-z]+)(?:\/(submit|history))?$/;
const API_PATH = /^\/api\/([a-z]+)$/;

async function handleAdmin(engine: TargetsEngine, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (path === '/__truth' && request.method === 'GET') {
    sendJson(response, 200, engine.truth());
    return true;
  }
  if (path === '/__reset' && request.method === 'POST') {
    engine.reset();
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (path === '/__faults' && request.method === 'POST') {
    let plan: FaultPlan;
    try {
      plan = parseFaultPlan(JSON.parse(await readBody(request)));
    } catch (error) {
      if (!(error instanceof FaultPlanError || error instanceof SyntaxError)) throw error;
      sendJson(response, 400, { error: error.message });
      return true;
    }
    engine.setFaults(plan);
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function route(engine: TargetsEngine, request: IncomingMessage, response: ServerResponse, arrivalMs: number): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://targets.invalid').pathname;
  if (await handleAdmin(engine, path, request, response)) return;
  const api = API_PATH.exec(path);
  if (api !== null && isTargetName(api[1])) {
    await handleApi(engine, api[1], request, response, arrivalMs);
    return;
  }
  const ui = UI_PATH.exec(path);
  if (ui !== null && isTargetName(ui[1])) {
    await handleUi(engine, ui[1], ui[2] === 'submit' || ui[2] === 'history' ? ui[2] : 'form', request, response, arrivalMs);
    return;
  }
  if (path === '/' && request.method === 'GET') {
    sendHtml(response, 200, indexHtml());
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof BodyTooLargeError) sendJson(response, 413, { error: error.message });
  else sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
}

export async function startTargets(options: TargetsOptions): Promise<RunningTargets> {
  const engine = new TargetsEngine(options.clock, options.honourIdempotencyKey ?? false);
  const server = createServer((request, response) => {
    const arrivalMs = options.clock.nowMs();
    route(engine, request, response, arrivalMs).catch((error: unknown) => fail(response, error));
  });
  const host = options.host ?? DEFAULT_HOST;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    setFaults: (plan) => engine.setFaults(plan),
    truth: () => engine.truth(),
    reset: () => engine.reset(),
    pendingCommits: () => engine.pendingCommits(),
    close() {
      closing ??= new Promise<void>((resolve) => {
        engine.cancelPending();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
