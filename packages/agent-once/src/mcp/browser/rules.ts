import type { BrowserConfig } from '../../config/schema.js';
import { classifyTool, matchesAnyPattern } from '../../guard/classify.js';
import type { GuardPolicy, ToolClass } from '../../ledger/types.js';
import { compiled } from './compiled.js';
import { normalizePageUrl, type PageState } from './page-state.js';
import type { BrowserProfile } from './profile.js';

export interface BrowserCallRule {
  policy: 'pass' | GuardPolicy;
  toolClass: ToolClass;
  extraIdentity?: { page_url: string; label: string };
  captured?: string;
}

type Args = Record<string, unknown>;
type SideEffectKind = 'element' | 'keyboard';

interface SideEffectTool {
  kind: SideEffectKind;
  applies(args: Args): boolean;
}

const ENTER_KEYS: ReadonlySet<unknown> = new Set(['Enter', 'NumpadEnter']);
const ALWAYS = (): boolean => true;
const element: SideEffectTool = { kind: 'element', applies: ALWAYS };
const pressesEnter: SideEffectTool = { kind: 'keyboard', applies: (args) => ENTER_KEYS.has(args.key) };

const SIDE_EFFECT_TOOLS: Readonly<Record<BrowserProfile, ReadonlyMap<string, SideEffectTool>>> = {
  playwright: new Map([
    ['browser_click', element],
    ['browser_type', { kind: 'keyboard', applies: (args) => args.submit === true }],
    ['browser_press_key', pressesEnter],
    ['browser_select_option', element],
    ['browser_file_upload', element],
    ['browser_drop', element],
  ]),
  'chrome-devtools': new Map([
    ['click', element],
    ['type_text', { kind: 'keyboard', applies: (args) => ENTER_KEYS.has(args.submitKey) }],
    ['press_key', pressesEnter],
    ['upload_file', element],
    ['drag', element],
  ]),
};

const PAGE_TOOLS: Readonly<Record<BrowserProfile, ReadonlySet<string>>> = {
  playwright: new Set(['browser_navigate', 'browser_navigate_back', 'browser_tabs', 'browser_snapshot']),
  'chrome-devtools': new Set(['navigate_page', 'new_page', 'select_page', 'list_pages', 'take_snapshot']),
};

export const SNAPSHOT_TOOL: Readonly<Record<BrowserProfile, string>> = { playwright: 'browser_snapshot', 'chrome-devtools': 'take_snapshot' };
export const NAVIGATE_TOOL: Readonly<Record<BrowserProfile, string>> = { playwright: 'browser_navigate', 'chrome-devtools': 'navigate_page' };
const NAVIGATION_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_navigate_back', 'browser_tabs', 'navigate_page', 'new_page', 'select_page']);
const PLAYWRIGHT_REF = /^(?:f\d+)?e\d+$/;

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

export function isSideEffectCall(profile: BrowserProfile, tool: string, args: Args): boolean {
  return SIDE_EFFECT_TOOLS[profile].get(tool)?.applies(args) === true;
}

export function observesPage(profile: BrowserProfile, tool: string): boolean {
  return PAGE_TOOLS[profile].has(tool) || SIDE_EFFECT_TOOLS[profile].has(tool);
}

export function isNavigationTool(tool: string): boolean {
  return NAVIGATION_TOOLS.has(tool);
}

export function profileForTool(tool: string): BrowserProfile | undefined {
  return (['playwright', 'chrome-devtools'] as const).find((profile) => isKnownBrowserTool(profile, tool));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function snapshotLabel(profile: BrowserProfile, args: Args, page: PageState): { label?: string; unresolvedRef: boolean } {
  let unresolvedRef = false;
  for (const key of ELEMENT_KEYS[profile]) {
    const ref = args[key];
    if (typeof ref !== 'string' || ref === '') continue;
    const label = page.labelFor(ref);
    if (label !== undefined) return { label, unresolvedRef: false };
    unresolvedRef = true;
  }
  return { unresolvedRef };
}

function resolveLabel(profile: BrowserProfile, args: Args, page: PageState): string {
  const found = snapshotLabel(profile, args, page).label;
  if (found !== undefined) return found;
  const description = text(args.element);
  if (description !== '') return description;
  const target = text(args.target);
  return profile === 'playwright' && target !== '' && !PLAYWRIGHT_REF.test(target) ? target : '';
}

function capture(cfg: BrowserConfig, page: PageState): string | undefined {
  const url = page.url();
  if (url === undefined || !page.snapshotIsCurrent()) return undefined;
  for (const rule of compiled(cfg).capture) {
    if (!rule.url.test(url)) continue;
    const match = rule.regex.exec(page.lastText());
    if (match !== null) return match[1] ?? match[0];
  }
  return undefined;
}

export function browserIdentity(profile: BrowserProfile, args: Args, page: PageState): { page_url: string; label: string } {
  const url = page.url();
  return { page_url: url === undefined ? '' : normalizePageUrl(url), label: resolveLabel(profile, args, page) };
}

function sideEffectTexts(tool: SideEffectTool, args: Args, page: PageState, identity: { page_url: string; label: string }): string[] {
  if (tool.kind === 'keyboard') return [identity.page_url, page.title() ?? '', ...page.actionLabels()];
  const described = [identity.label, text(args.element)].filter((value) => value !== '');
  return described.length > 0 ? described : [identity.page_url];
}

function guarded(toolClass: ToolClass, identity: { page_url: string; label: string }, captured: string | undefined): BrowserCallRule {
  return {
    policy: toolClass === 'standard' ? 'guard' : 'block-on-doubt',
    toolClass,
    extraIdentity: identity,
    ...(captured === undefined ? {} : { captured }),
  };
}

export function browserCallRule(profile: BrowserProfile, tool: string, args: Args, page: PageState, cfg: BrowserConfig): BrowserCallRule {
  const sideEffect = SIDE_EFFECT_TOOLS[profile].get(tool);
  if (sideEffect === undefined || !sideEffect.applies(args)) return { policy: 'pass', toolClass: 'standard' };
  const identity = browserIdentity(profile, args, page);
  const captured = capture(cfg, page);
  if (profile === 'chrome-devtools' && sideEffect.kind === 'element' && snapshotLabel(profile, args, page).unresolvedRef) {
    return guarded('standard', identity, captured);
  }
  const matching = sideEffectTexts(sideEffect, args, page, identity).filter((value) => matchesAnyPattern('', value, cfg.sideEffectPatterns));
  if (matching.length === 0) return { policy: 'pass', toolClass: 'standard' };
  return guarded(classifyTool('', matching.join(' '), { money: cfg.moneyPatterns, irreversible: cfg.irreversiblePatterns }), identity, captured);
}
