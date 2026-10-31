import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NAMES = ['AGENT_ONCE_CHAOS_URL', 'AGENT_ONCE_CHAOS_MCP', 'AGENT_ONCE_TASK', 'AGENT_ONCE_SESSION'];
const env = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const command = JSON.parse(process.env.AGENT_ONCE_CHAOS_MCP ?? '[]');
const configAt = command.indexOf('--config');
const configPath = configAt === -1 ? null : command[configAt + 1];
const config = configPath === null ? null : JSON.parse(readFileSync(configPath, 'utf8'));
const configCopy = configPath === null ? null : join(dirname(process.argv[2]), 'agent-once-copy.json');
if (configPath !== null) copyFileSync(configPath, configCopy);
writeFileSync(process.argv[2], JSON.stringify({ env, config, configPath, configCopy }));
