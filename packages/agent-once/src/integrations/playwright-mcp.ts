export const PLAYWRIGHT_MCP_VERSION = '0.0.83';

export interface PlaywrightMcpServerOptions {
  version?: string;
  headless?: boolean;
  config?: string;
  session?: string;
}

export interface StdioMcpServerConfig {
  command: string;
  args: string[];
}

export function playwrightMcpServer(options: PlaywrightMcpServerOptions = {}): StdioMcpServerConfig {
  const proxyArgs = [
    ...(options.config === undefined ? [] : ['--config', options.config]),
    ...(options.session === undefined ? [] : ['--session', options.session]),
  ];
  const playwright = [`@playwright/mcp@${options.version ?? PLAYWRIGHT_MCP_VERSION}`, ...(options.headless === true ? ['--headless'] : [])];
  return { command: 'npx', args: ['agent-once', 'mcp', ...proxyArgs, '--', 'npx', ...playwright] };
}
