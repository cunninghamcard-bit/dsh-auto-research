/**
 * Locations and availability probes for the real end-to-end tests.
 *
 * Every path is derived from this repository (or the user's home directory)
 * and can be overridden by an environment variable, so the suite is portable:
 * no machine-specific absolute path is baked into the repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Absolute path of the deepseek-harness checkout (its built libraries). */
export const DSH_ROOT = process.env.DSH_HARNESS_ROOT ?? resolve(import.meta.dirname, '../../deepseek-harness')
/** Absolute path of the LayerFS checkout holding `api/agent` and `api/runtime`. */
export const LAYERFS_ROOT = process.env.LAYERFS_ROOT ?? resolve(import.meta.dirname, '../../layerfs')
/**
 * The sealed Linux LayerFS build (daemon, addon, SDK and `manifest.json`) the
 * macOS worker runs: `LAYERFS_BUNDLE`, else the newest one `tools/worktree.py
 * build` made under `~/.cache/layerfs-worktrees`.
 */
export const LAYERFS_BUNDLE = process.env.LAYERFS_BUNDLE ?? newestSealedBundle()
/** The Docker Engine socket the live Sandboxes are started through. */
export const LAYERFS_DOCKER = process.env.LAYERFS_DOCKER ?? [
  join(homedir(), '.orbstack/run/docker.sock'),
  join(homedir(), '.docker/run/docker.sock'),
  '/var/run/docker.sock',
].find(path => existsSync(path)) ?? join(homedir(), '.orbstack/run/docker.sock')
/** The installed `dsh` home holding the `web` profile. */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** The runtime image built from dsh-layerfs's `tools/runtime`. */
export const RUNTIME_TAG = process.env.LAYERFS_RUNTIME_IMAGE ?? 'layerfs-352-runtime:node24'

/** Whether the real dsh stack (cordis, subagent service, agent-loop testkit) can be imported. */
export function dshStackAvailable() {
  return [
    `${DSH_ROOT}/vendor/cordis/lib/index.js`,
    `${DSH_ROOT}/packages/subagent/subagent/lib/index.js`,
    `${DSH_ROOT}/packages/test-support/agent-loop-testkit/lib/index.js`,
  ].every(existsSync)
}

/** Whether the LayerFS checkout's agent SDK and runtime are linked (`npm install` in `api`). */
export function layerfsApiAvailable() {
  return [
    `${LAYERFS_ROOT}/api/agent/src/index.js`,
    `${LAYERFS_ROOT}/api/runtime/src/index.js`,
    `${LAYERFS_ROOT}/api/node_modules/@layerfs/agent`,
  ].every(existsSync)
}

function newestSealedBundle(): string {
  const root = join(homedir(), '.cache/layerfs-worktrees')
  const bundles: string[] = []
  for (const registration of existsSync(root) ? readdirSync(root) : []) {
    const artifacts = join(root, registration, 'artifacts')
    for (const name of existsSync(artifacts) ? readdirSync(artifacts) : []) {
      if (name.startsWith('build-linux-') && existsSync(join(artifacts, name, 'manifest.json'))) bundles.push(join(artifacts, name))
    }
  }
  bundles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return bundles[0] ?? join(root, 'none')
}

/**
 * Whether OrbStack Docker and the sealed Linux bundle are usable here.
 *
 * The socket file existing is not enough: OrbStack may be installed while its
 * engine is stopped, and a live Sandbox mount then fails with `Connection
 * refused`. `docker version` is the only probe that proves the daemon answers.
 */
export function liveLayerfsAvailable() {
  if (process.platform !== 'darwin') return false
  if (!existsSync(`${LAYERFS_BUNDLE}/manifest.json`) || !existsSync(`${LAYERFS_BUNDLE}/layerfs-daemon`)) return false
  if (!existsSync(LAYERFS_DOCKER)) return false
  try {
    execFileSync('docker', ['-H', `unix://${LAYERFS_DOCKER}`, 'version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}
