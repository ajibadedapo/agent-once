import { isSnapshotText, parseSnapshot, snapshotStart } from './snapshot-labels.js';

const NAVIGATION_ARG_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'navigate_page', 'new_page']);
const NAVIGATED_PREFIXES: readonly string[] = ['Successfully navigated to ', 'Page navigated to '];
const PAGE_URL_PREFIX = '- Page URL: ';
const PAGE_TITLE_PREFIX = '- Page Title: ';
const SELECTED_SUFFIX = ' [selected]';
const ROOT_WEB_AREA = ' RootWebArea "';
const URL_ATTRIBUTE = ' url="';

interface PageFacts {
  url?: string;
  title?: string;
}

function isUrlToken(text: string): boolean {
  return text !== '' && !/\s/.test(text);
}

function isDigits(text: string): boolean {
  return text !== '' && [...text].every((char) => char >= '0' && char <= '9');
}

function selectedPage(line: string): PageFacts | undefined {
  const colon = line.indexOf(': ');
  if (colon === -1 || !isDigits(line.slice(0, colon)) || !line.endsWith(SELECTED_SUFFIX)) return undefined;
  const entry = line.slice(colon + 2, -SELECTED_SUFFIX.length);
  const open = entry.lastIndexOf(' (');
  if (open === -1 || !entry.endsWith(')')) return undefined;
  const url = entry.slice(open + 2, -1);
  return isUrlToken(url) ? { url, title: entry.slice(0, open) } : undefined;
}

function headerFacts(header: string): PageFacts {
  const facts: PageFacts = {};
  for (const line of header.split('\n')) {
    if (line.startsWith(PAGE_URL_PREFIX)) {
      const url = line.slice(PAGE_URL_PREFIX.length);
      if (isUrlToken(url)) facts.url = url;
      continue;
    }
    if (line.startsWith(PAGE_TITLE_PREFIX)) {
      facts.title = line.slice(PAGE_TITLE_PREFIX.length);
      continue;
    }
    const prefix = NAVIGATED_PREFIXES.find((candidate) => line.startsWith(candidate));
    if (prefix !== undefined) {
      const rest = line.slice(prefix.length);
      const url = rest.endsWith('.') ? rest.slice(0, -1) : rest;
      if (isUrlToken(url)) facts.url = url;
      continue;
    }
    const selected = selectedPage(line);
    if (selected !== undefined) Object.assign(facts, selected);
  }
  return facts;
}

function rootFacts(body: string): PageFacts {
  const firstLine = body.split('\n', 2).find((line) => line.trim() !== '') ?? '';
  const line = firstLine.trimStart();
  const root = line.indexOf(ROOT_WEB_AREA);
  if (!line.startsWith('uid=') || root === -1 || root !== line.indexOf(' ')) return {};
  const attribute = line.lastIndexOf(URL_ATTRIBUTE);
  const facts: PageFacts = {};
  if (attribute > root) {
    const start = attribute + URL_ATTRIBUTE.length;
    const end = line.indexOf('"', start);
    const url = end === -1 ? '' : line.slice(start, end);
    if (isUrlToken(url) && end === line.length - 1) facts.url = url;
    const title = line.slice(root + ROOT_WEB_AREA.length, attribute);
    if (title.endsWith('"')) facts.title = title.slice(0, -1);
  }
  return facts;
}

export function normalizePageUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const cut = [url.indexOf('?'), url.indexOf('#')].filter((index) => index !== -1);
    return cut.length === 0 ? url : url.slice(0, Math.min(...cut));
  }
  const origin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  return origin + parsed.pathname;
}

export function pageOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

export class PageState {
  private currentUrl: string | undefined;
  private currentTitle: string | undefined;
  private labels = new Map<string, string>();
  private actions: string[] = [];
  private snapshotText = '';
  private snapshotUrl: string | undefined;

  url(): string | undefined {
    return this.currentUrl;
  }

  title(): string | undefined {
    return this.currentTitle;
  }

  labelFor(ref: string): string | undefined {
    return this.labels.get(ref);
  }

  lastText(): string {
    return this.snapshotText;
  }

  snapshotIsCurrent(): boolean {
    return this.snapshotUrl !== undefined && this.currentUrl !== undefined && normalizePageUrl(this.snapshotUrl) === normalizePageUrl(this.currentUrl);
  }

  actionLabels(): string[] {
    return this.snapshotIsCurrent() ? [...this.actions] : [];
  }

  observe(tool: string, args: Record<string, unknown>, resultText: string): void {
    if (NAVIGATION_ARG_TOOLS.has(tool) && typeof args.url === 'string' && args.url !== '') {
      this.currentUrl = args.url;
      this.currentTitle = undefined;
    }
    const start = snapshotStart(resultText);
    const header = start === -1 ? resultText : resultText.slice(0, start);
    const facts = { ...headerFacts(header), ...(start === -1 ? {} : rootFacts(resultText.slice(start).split('\n').slice(1).join('\n'))) };
    if (facts.url !== undefined && facts.url !== this.currentUrl) {
      this.currentUrl = facts.url;
      this.currentTitle = undefined;
    }
    if (facts.title !== undefined) this.currentTitle = facts.title;
    if (isSnapshotText(resultText)) {
      const parsed = parseSnapshot(resultText.slice(start));
      this.labels = parsed.labels;
      this.actions = parsed.actions;
      this.snapshotText = resultText;
      this.snapshotUrl = this.currentUrl;
    }
  }
}
