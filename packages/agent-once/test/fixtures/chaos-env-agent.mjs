import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = ['AGENT_ONCE_CHAOS_URL', 'AGENT_ONCE_CHAOS_MCP', 'AGENT_ONCE_TASK', 'AGENT_ONCE_SESSION'];
const env = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const command = JSON.parse(process.env.AGENT_ONCE_CHAOS_MCP ?? '[]');
const configAt = command.indexOf('--config');
const config = configAt === -1 ? null : JSON.parse(readFileSync(command[configAt + 1], 'utf8'));
writeFileSync(process.argv[2], JSON.stringify({ env, config }));
