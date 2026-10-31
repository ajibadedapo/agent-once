const PLAYWRIGHT_SNAPSHOT = /^### Snapshot\n```yaml\n/m;
const CHROME_DEVTOOLS_SNAPSHOT = /^## Latest page snapshot$/m;
const PLAYWRIGHT_LINE = /^\s*- [^\s"[]+(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s*(.*))?$/;
const PLAYWRIGHT_REF = /\[ref=([^\]]+)\]/;
const CHROME_DEVTOOLS_LINE = /^\s*uid=(\S+)(?: [^\s"]+)?(?: "((?:[^"\\]|\\.)*)")?/;

function unquote(text: string): string {
  const trimmed = text.trim();
  const inner = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return inner.replace(/\\(.)/g, '$1');
}

function playwrightLabel(line: string): [string, string] | undefined {
  const match = PLAYWRIGHT_LINE.exec(line);
  const ref = match?.[2] === undefined ? undefined : PLAYWRIGHT_REF.exec(match[2])?.[1];
  if (match === null || ref === undefined) return undefined;
  const label = match[1] !== undefined ? unquote(`"${match[1]}"`) : unquote(match[3] ?? '');
  return label === '' ? undefined : [ref, label];
}

function chromeDevtoolsLabel(line: string): [string, string] | undefined {
  const match = CHROME_DEVTOOLS_LINE.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const label = unquote(`"${match[2]}"`);
  return label === '' ? undefined : [match[1], label];
}

export function isSnapshotText(text: string): boolean {
  return PLAYWRIGHT_SNAPSHOT.test(text) || CHROME_DEVTOOLS_SNAPSHOT.test(text);
}

export function parseSnapshotLabels(text: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const line of text.split('\n')) {
    const entry = playwrightLabel(line) ?? chromeDevtoolsLabel(line);
    if (entry !== undefined && !labels.has(entry[0])) labels.set(entry[0], entry[1]);
  }
  return labels;
}
