/**
 * Barrel for the package `main`/`types` entry points.
 *
 * Consumers normally use subpath imports (e.g. `@diffstalker/core/git/status`,
 * `@diffstalker/core/managers/GitStateManager`); this re-exports the primary
 * managers so the bare `@diffstalker/core` specifier also resolves.
 */
export { GitStateManager } from './managers/GitStateManager.js';
export { WorkingTreeManager } from './managers/WorkingTreeManager.js';
export { HistoryManager } from './managers/HistoryManager.js';
export { CompareManager } from './managers/CompareManager.js';
export { RemoteOperationManager } from './managers/RemoteOperationManager.js';
export { GitOperationQueue } from './managers/GitOperationQueue.js';
export { FilePathWatcher } from './managers/FilePathWatcher.js';
export { ExplorerStateManager } from './managers/ExplorerStateManager.js';
