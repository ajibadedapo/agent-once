import type { BrowserConfig } from '../../config/schema.js';
import { classifyTool, matchesAnyPattern } from '../../guard/classify.js';
import type { GuardPolicy, ToolClass } from '../../ledger/types.js';
import { normalizePageUrl, type PageState } from './page-state.js';
import type { BrowserProfile } from './profile.js';

export interface BrowserCallRule {
  policy: 'pass' | GuardPolicy;
  toolClass: ToolClass;
  extraIdentity?: { page_url: string; label: string };
  captured?: string;
}

type Args = Record<string, unknown>;
type SideEffectCheck = (args: Args) => boolean;

const ALWAYS: SideEffectCheck = () => true;
const PRESSES_ENTER: SideEffectCheck = (args) => args.key === 'Enter';

const SIDE_EFFECT_TOOLS: Readonly<Record<BrowserProfile, ReadonlyMap<string, SideEffectCheck>>> = {
  playwright: new Map([
    ['browser_click', ALWAYS],
    ['browser_type', (args) => args.submit === true],
    ['browser_press_key', PRESSES_ENTER],
    ['browser_select_option', ALWAYS],
    ['browser_file_upload', ALWAYS],
    ['browser_drop', ALWAYS],
  ]),
  'chrome-devtools': new Map([
    ['click', ALWAYS],
    ['type_text', (args) => typeof args.submitKey === 'string' && args.submitKey !== ''],
    ['press_key', PRESSES_ENTER],
    ['upload_file', ALWAYS],
    ['drag', ALWAYS],
  ]),
};

const PASSING_TOOLS: Readonly<Record<BrowserProfile, ReadonlySet<string>>> = {
  playwright: new Set([
    'browser_close',
    'browser_resize',
    'browser_console_messages',
    'browser_handle_dialog',
    'browser_emulate_media',
    'browser_evaluate',
    'browser_fill_form',
    'browser_find',
    'browser_navigate',
    'browser_navigate_back',
    'browser_network_requests',
    'browser_network_request',
    'browser_take_screenshot',
    'browser_snapshot',
    'browser_drag',
    'browser_hover',
    'browser_tabs',
    'browser_wait_for',
  ]),
  'chrome-devtools': new Set([
    'close_page',
    'emulate',
    'evaluate_script',
    'fill',
    'fill_form',
    'get_console_message',
    'get_css_styles',
    'get_network_request',
    'handle_dialog',
    'hover',
    'lighthouse_audit',
    'list_console_messages',
    'list_network_requests',
    'list_pages',
    'navigate_page',
    'new_page',
    'performance_analyze_insight',
    'performance_start_trace',
    'performance_stop_trace',
    'resize_page',
    'screencast_start',
    'screencast_stop',
    'select_page',
    'take_heapsnapshot',
    'take_screenshot',
    'take_snapshot',
    'wait_for',
  ]),
};

const ELEMENT_KEYS: Readonly<Record<BrowserProfile, readonly string[]>> = {
  playwright: ['target', 'ref'],
  'chrome-devtools': ['uid', 'from_uid'],
};

export function isKnownBrowserTool(profile: BrowserProfile, tool: string): boolean {
  return SIDE_EFFECT_TOOLS[profile].has(tool) || PASSING_TOOLS[profile].has(tool);
}

export function isSideEffectTool(profile: BrowserProfile, tool: string): boolean {
  return SIDE_EFFECT_TOOLS[profile].has(tool);
}

export function profileForTool(tool: string): BrowserProfile | undefined {
  return (['playwright', 'chrome-devtools'] as const).find((profile) => isKnownBrowserTool(profile, tool));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveLabel(profile: BrowserProfile, args: Args, page: PageState): string {
  for (const key of ELEMENT_KEYS[profile]) {
    const ref = args[key];
    const label = typeof ref === 'string' ? page.labelFor(ref) : undefined;
    if (label !== undefined) return label;
  }
  return text(args.element);
}

function capture(cfg: BrowserConfig, url: string, page: PageState): string | undefined {
  for (const rule of cfg.capture) {
    if (!new RegExp(rule.urlPattern, 'i').test(url)) continue;
    const match = new RegExp(rule.regex, 'm').exec(page.lastText());
    if (match !== null) return match[1] ?? match[0];
  }
  return undefined;
}

export function browserIdentity(profile: BrowserProfile, args: Args, page: PageState): { page_url: string; label: string } {
  const url = page.url();
  return { page_url: url === undefined ? '' : normalizePageUrl(url), label: resolveLabel(profile, args, page) };
}

export function browserCallRule(profile: BrowserProfile, tool: string, args: Args, page: PageState, cfg: BrowserConfig): BrowserCallRule {
  const isSideEffect = SIDE_EFFECT_TOOLS[profile].get(tool);
  if (isSideEffect === undefined || !isSideEffect(args)) return { policy: 'pass', toolClass: 'standard' };
  const identity = browserIdentity(profile, args, page);
  const subject = [identity.label, text(args.element), identity.page_url].join(' ');
  if (!matchesAnyPattern('', subject, cfg.sideEffectPatterns)) return { policy: 'pass', toolClass: 'standard' };
  const toolClass = classifyTool('', subject, { money: cfg.moneyPatterns, irreversible: cfg.irreversiblePatterns });
  const captured = capture(cfg, page.url() ?? '', page);
  return {
    policy: toolClass === 'standard' ? 'guard' : 'block-on-doubt',
    toolClass,
    extraIdentity: identity,
    ...(captured === undefined ? {} : { captured }),
  };
}
