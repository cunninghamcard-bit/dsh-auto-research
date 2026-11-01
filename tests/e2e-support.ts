/**
 * Locations and availability probes for the real end-to-end tests.
 *
 * Every path is derived from this repository (or the user's home directory)
 * and can be overridden by an environment variable, so the suite is portable:
 * no machine-specific absolute path is baked into the repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Absolute path of the deepseek-harness checkout (its built libraries). */
export const DSH_ROOT = process.env.DSH_HARNESS_ROOT ?? resolve(import.meta.dirname, '../../deepseek-harness')
/** Absolute path of the LayerFS checkout holding `@dsh-layerfs/host`. */
export const LAYERFS_ROOT = process.env.LAYERFS_ROOT ?? resolve(import.meta.dirname, '../../layerfs')
export const LAYERFS_HOST = `${LAYERFS_ROOT}/dsh/packages/host`
/** Folder of the sealed Linux LayerFS build (daemon + SDK) used by Live. */
export const LAYERFS_BUNDLE = process.env.LAYERFS_BUNDLE ?? join(homedir(), 'layerfs-linux-build')
/** The Docker Engine socket the live Sandboxes are started through. */
export const LAYERFS_DOCKER = process.env.LAYERFS_DOCKER ?? [
  join(homedir(), '.orbstack/run/docker.sock'),
  join(homedir(), '.docker/run/docker.sock'),
  '/var/run/docker.sock',
].find(path => existsSync(path)) ?? join(homedir(), '.orbstack/run/docker.sock')
/** The installed `dsh` home holding the `web` profile. */
export const DSH_HOME = process.env.DSH_HOME ?? [
  join(homedir(), 'dsh-layerfs'),
  join(homedir(), '.dsh'),
].find(path => existsSync(path)) ?? join(homedir(), 'dsh-layerfs')

/** The runtime image built from `dsh/tools/history/runtime`. */
export const RUNTIME_TAG = process.env.LAYERFS_RUNTIME_IMAGE ?? 'layerfs-352-runtime:node24'

/** Whether the real dsh stack (cordis, subagent service, agent-loop testkit) can be imported. */
export function dshStackAvailable() {
  return [
    `${DSH_ROOT}/vendor/cordis/lib/index.js`,
    `${DSH_ROOT}/packages/subagent/subagent/lib/index.js`,
    `${DSH_ROOT}/packages/test-support/agent-loop-testkit/lib/index.js`,
  ].every(existsSync)
}

/** Whether the LayerFS host package (sim and ported SDKs, box.js) is available. */
export function layerfsHostAvailable() {
  return [`${LAYERFS_HOST}/src/box.js`, `${LAYERFS_HOST}/src/sim/sdk.js`, `${LAYERFS_HOST}/src/port/sdk.js`].every(existsSync)
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
  if (!existsSync(LAYERFS_BUNDLE) || !existsSync(`${LAYERFS_BUNDLE}/layerfs-daemon`)) return false
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
