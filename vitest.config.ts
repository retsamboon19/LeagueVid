import { defineConfig } from 'vitest/config'

// Unit tests for the pure logic in the main process: ffmpeg argument
// construction, the recorder state reducer, stream parsers, and the
// filename/date and sync-offset arithmetic.
//
// Deliberately a Node environment with no jsdom, no Electron, and no
// setup file. Everything under test here is a pure function or a parser --
// if a test needs a window, a GPU, a running League client or the network,
// that's a signal the logic under test hasn't been separated from its I/O
// yet, not a reason to widen this config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Tests import { describe, it, expect } explicitly rather than relying
    // on globals, so the same files typecheck under the existing
    // tsconfig.node.json / tsconfig.web.json projects.
    globals: false
  }
})
