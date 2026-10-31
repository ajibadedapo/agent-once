import { isSnapshotText, parseSnapshotLabels } from './snapshot-labels.js';

const NAVIGATION_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'navigate_page', 'new_page']);
const URL_PATTERNS: readonly RegExp[] = [
  /^\d+: .*\((\S+)\) \[selected\]$/gm,
  /navigated to (\S+?)\.?$/gm,
  /^\s*uid=\S+ RootWebArea "(?:[^"\\]|\\.)*" url="([^"]+)"/gm,
  /^- Page URL: (\S+)$/gm,
];

function lastMatch(text: string, pattern: RegExp): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) found = match[1];
  return found;
}

export function normalizePageUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.replace(/[?#].*$/s, '');
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
  private labels = new Map<string, string>();
  private snapshotText = '';

  url(): string | undefined {
    return this.currentUrl;
  }

  labelFor(ref: string): string | undefined {
    return this.labels.get(ref);
  }

  lastText(): string {
    return this.snapshotText;
  }

  observe(tool: string, args: Record<string, unknown>, resultText: string): void {
    if (NAVIGATION_TOOLS.has(tool) && typeof args.url === 'string' && args.url !== '') this.currentUrl = args.url;
    for (const pattern of URL_PATTERNS) {
      const url = lastMatch(resultText, pattern);
      if (url !== undefined) this.currentUrl = url;
    }
    if (isSnapshotText(resultText)) {
      this.labels = parseSnapshotLabels(resultText);
      this.snapshotText = resultText;
    }
  }
}
