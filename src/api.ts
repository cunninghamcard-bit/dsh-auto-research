/**
 * `dsh-auto-research/api`: the contract for backend plugins.
 *
 * Plugins outside this package import only from here: the interface types and
 * the shared workspace utilities. This module registers nothing.
 */

export {
  OMIT,
  inventory,
  jsonDigest,
  restoreCompletedState,
  retainCompletedState,
  sha256,
  snapshot,
  writeJsonAtomic,
} from './layerfs-workspace.js'
export type {
  PluginContext,
  ResearchWorkspaceService,
  TrajectoryRow,
  WorkspaceBackend,
  WorkspaceBackendCreateOptions,
  WorkspaceBackendFactory,
  WorkspaceState,
} from './types.js'
