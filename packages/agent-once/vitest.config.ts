import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.e2e.test.ts'],
    globalSetup: ['test/global-build.ts'],
    environment: 'node',
  },
});
