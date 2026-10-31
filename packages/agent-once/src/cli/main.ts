#!/usr/bin/env node
import { homedir } from 'node:os';
import { LedgerUnavailableError } from '../ledger/errors.js';
import { LEDGER_USAGE, runLedger } from './commands/ledger.js';
import { MCP_USAGE, runMcp } from './commands/mcp.js';
import { RESOLVE_USAGE, runResolve } from './commands/resolve.js';
import { CliExit, EXIT_LEDGER, EXIT_OK, EXIT_USAGE, type CliIo } from './io.js';

const USAGE = ['Usage:', `  ${MCP_USAGE.replace('Usage: ', '')}`, `  ${RESOLVE_USAGE.replace('Usage: ', '')}`, `  ${LEDGER_USAGE.replace('Usage: ', '')}`].join('\n');

const EXIT_GRACE_MS = 2000;

async function run(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mcp':
      return runMcp(rest, io);
    case 'resolve':
      return runResolve(rest, io);
    case 'ledger':
      return runLedger(rest, io);
    case 'help':
    case '--help':
    case '-h':
      io.stdout(`${USAGE}\n`);
      return EXIT_OK;
    default:
      throw new CliExit(EXIT_USAGE, USAGE);
  }
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof CliExit) {
      io.stderr(`${error.message}\n`);
      return error.code;
    }
    if (error instanceof LedgerUnavailableError) {
      io.stderr(`${error.message}\n`);
      return EXIT_LEDGER;
    }
    throw error;
  }
}

const io: CliIo = {
  env: process.env,
  cwd: process.cwd(),
  homedir: homedir(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const code = await main(process.argv.slice(2), io);
process.exitCode = code;
setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
