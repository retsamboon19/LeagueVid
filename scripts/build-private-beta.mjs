import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const projectDir = dirname(scriptsDir)

dotenv.config({ path: join(projectDir, '.env') })

const apiKey = process.env.RIOT_API_KEY?.trim()
if (!apiKey) {
  console.error('Private beta build requires RIOT_API_KEY in the local .env file.')
  process.exit(1)
}

const buildEnv = {
  ...process.env,
  LEAGUEVID_BUNDLED_RIOT_API_KEY: apiKey
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectDir,
    env: buildEnv,
    stdio: 'inherit'
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

runNode(join(projectDir, 'node_modules/electron-vite/bin/electron-vite.js'), ['build'])
runNode(join(projectDir, 'node_modules/electron-builder/out/cli/cli.js'), ['--publish', 'never'])
