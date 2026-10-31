import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    exclude: [...configDefaults.exclude],
    globalSetup: ['test/global-build.ts'],
    fileParallelism: false,
    environment: 'node',
  },
});
