import { DEFAULT_BROWSER_CONFIG, type AgentOnceConfig, type BrowserReadBackRule, type ToolRule } from '../config/schema.js';
import { STALE_FORM_ERROR } from './targets/api-routes.js';
import { TARGET_NAMES, TARGETS, type TargetName } from './targets/catalog.js';

const API_READ_BACK: Readonly<Record<string, string>> = {
  place_order: 'list_orders',
  book_slot: 'list_bookings',
  send_email: 'list_sent_emails',
  create_ticket: 'list_tickets',
};

function targetUrlPattern(target: TargetName): string {
  return `^https?://[^/]+/${target}(?:[/?#]|$)`;
}

function apiRule(listTool: string): ToolRule {
  return {
    readBack: { steps: [{ tool: listTool, args: {} }], happened: '"clientRef":"{{idempotency_key}}"', notHappened: '^\\[' },
    notDispatchedErrors: [STALE_FORM_ERROR],
  };
}

function browserReadBack(target: TargetName): BrowserReadBackRule {
  return {
    urlPattern: targetUrlPattern(target),
    steps: [
      { tool: 'browser_navigate', args: { url: `{{origin}}/${target}/history` } },
      { tool: 'browser_snapshot', args: {} },
    ],
    happened: '\\b{{captured}}\\b',
    notHappened: TARGETS[target].historyTitle,
  };
}

export function chaosTargetsPreset(): Pick<AgentOnceConfig, 'tools' | 'browser'> {
  return {
    tools: Object.fromEntries(Object.entries(API_READ_BACK).map(([tool, listTool]) => [tool, apiRule(listTool)])),
    browser: {
      enabled: DEFAULT_BROWSER_CONFIG.enabled,
      sideEffectPatterns: [...DEFAULT_BROWSER_CONFIG.sideEffectPatterns],
      moneyPatterns: [...DEFAULT_BROWSER_CONFIG.moneyPatterns],
      irreversiblePatterns: [...DEFAULT_BROWSER_CONFIG.irreversiblePatterns],
      notDispatchedErrors: [...DEFAULT_BROWSER_CONFIG.notDispatchedErrors, STALE_FORM_ERROR],
      successMarkers: [...DEFAULT_BROWSER_CONFIG.successMarkers],
      failureMarkers: [...DEFAULT_BROWSER_CONFIG.failureMarkers],
      capture: TARGET_NAMES.map((target) => ({ urlPattern: targetUrlPattern(target), regex: 'Reference (F-\\d+)' })),
      readBack: TARGET_NAMES.map(browserReadBack),
    },
  };
}
