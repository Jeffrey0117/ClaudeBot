import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs before any test module is imported, so the stores pick up
    // CLAUDEBOT_STATE_DIR when they capture their paths at module load.
    setupFiles: ['./tests/setup.ts'],
  },
})
