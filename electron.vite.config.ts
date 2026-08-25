import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'development'
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __LEAGUEVID_BUILD_COMMIT__: JSON.stringify(currentCommit()),
      // Empty for every normal/dev/release build. scripts/build-private-beta.mjs
      // supplies this only for the deliberately opt-in private beta build.
      __LEAGUEVID_BUNDLED_RIOT_API_KEY__: JSON.stringify(
        process.env.LEAGUEVID_BUNDLED_RIOT_API_KEY?.trim() ?? ''
      )
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
