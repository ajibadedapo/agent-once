const SNAPSHOT_MARKERS: readonly string[] = ['### Snapshot\n```yaml\n', '## Latest page snapshot\n'];
const PLAYWRIGHT_LINE = /^\s*- ([^\s"[:]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s*(.*))?$/;
const PLAYWRIGHT_REF = /\[ref=([^\]]+)\]/;
const CHROME_DEVTOOLS_LINE = /^\s*uid=(\S+)(?: ([^\s"]+))?(?: "((?:[^"\\]|\\.)*)")?/;
const ACTION_ROLES: ReadonlySet<string> = new Set(['button', 'link']);

interface SnapshotEntry {
  ref: string;
  role: string;
  label: string;
}

export interface ParsedSnapshot {
  labels: Map<string, string>;
  actions: string[];
}

function unquote(text: string): string {
  const trimmed = text.trim();
  const inner = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return inner.replace(/\\(.)/g, '$1');
}

function playwrightEntry(line: string): SnapshotEntry | undefined {
  const match = PLAYWRIGHT_LINE.exec(line);
  const ref = match?.[3] === undefined ? undefined : PLAYWRIGHT_REF.exec(match[3])?.[1];
  if (match?.[1] === undefined || ref === undefined) return undefined;
  const label = match[2] !== undefined ? unquote(`"${match[2]}"`) : unquote(match[4] ?? '');
  return label === '' ? undefined : { ref, role: match[1], label };
}

function chromeDevtoolsEntry(line: string): SnapshotEntry | undefined {
  const match = CHROME_DEVTOOLS_LINE.exec(line);
  if (match?.[1] === undefined || match[3] === undefined) return undefined;
  const label = unquote(`"${match[3]}"`);
  return label === '' ? undefined : { ref: match[1], role: match[2] ?? '', label };
}

function lineStartIndexOf(text: string, marker: string): number {
  for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + 1)) {
    if (index === 0 || text[index - 1] === '\n') return index;
  }
  return -1;
}

export function snapshotStart(text: string): number {
  const starts = SNAPSHOT_MARKERS.map((marker) => lineStartIndexOf(text, marker)).filter((index) => index !== -1);
  return starts.length === 0 ? -1 : Math.min(...starts);
}

export function isSnapshotText(text: string): boolean {
  return snapshotStart(text) !== -1;
}

export function parseSnapshot(text: string): ParsedSnapshot {
  const labels = new Map<string, string>();
  const actions: string[] = [];
  for (const line of text.split('\n')) {
    const entry = playwrightEntry(line) ?? chromeDevtoolsEntry(line);
    if (entry === undefined || labels.has(entry.ref)) continue;
    labels.set(entry.ref, entry.label);
    if (ACTION_ROLES.has(entry.role)) actions.push(entry.label);
  }
  return { labels, actions };
}
