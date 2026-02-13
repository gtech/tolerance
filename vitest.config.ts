import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '../shared/constants': './src/shared/constants',
      '../shared/types': './src/shared/types',
    },
  },
});
