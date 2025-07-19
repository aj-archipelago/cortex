import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['**/tests/**/*.test.js'],
    coverage: {
      include: ['*.js'],
      exclude: ['start.js'],
      provider: 'v8'
    }
  }
})
