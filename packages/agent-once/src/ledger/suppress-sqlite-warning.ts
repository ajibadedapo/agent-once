type EmitWarning = typeof process.emitWarning;
type NodeSqlite = typeof import('node:sqlite');

const SQLITE_MENTION = /sqlite/i;
const EXPERIMENTAL_WARNING = 'ExperimentalWarning';

let installed = false;

function warningType(warning: unknown, typeOrOptions: unknown): string | undefined {
  if (warning instanceof Error) return warning.name;
  if (typeof typeOrOptions === 'string') return typeOrOptions;
  if (typeof typeOrOptions === 'object' && typeOrOptions !== null && 'type' in typeOrOptions) {
    const { type } = typeOrOptions;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function isSqliteExperimentalWarning(args: unknown[]): boolean {
  const [warning, typeOrOptions] = args;
  const message = warning instanceof Error ? warning.message : warning;
  return typeof message === 'string' && SQLITE_MENTION.test(message) && warningType(warning, typeOrOptions) === EXPERIMENTAL_WARNING;
}

export function filterSqliteExperimentalWarning(emit: EmitWarning): EmitWarning {
  return function emitWarning(this: unknown, ...args: unknown[]): void {
    if (isSqliteExperimentalWarning(args)) return;
    Reflect.apply(emit, this, args);
  } as EmitWarning;
}

export function loadNodeSqlite(): NodeSqlite {
  if (!installed) {
    process.emitWarning = filterSqliteExperimentalWarning(process.emitWarning);
    installed = true;
  }
  return process.getBuiltinModule('node:sqlite');
}
