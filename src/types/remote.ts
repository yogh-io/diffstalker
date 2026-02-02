/**
 * Shared type for remote operation state (push/fetch/pull).
 * Lives in types/ so both ui/ and core/ can import it.
 */

export type RemoteOperation =
  | 'push'
  | 'fetch'
  | 'pull'
  | 'stash'
  | 'stashPop'
  | 'branchSwitch'
  | 'branchCreate'
  | 'softReset'
  | 'cherryPick'
  | 'revert';

export interface RemoteOperationState {
  operation: RemoteOperation | null;
  inProgress: boolean;
  error: string | null;
  lastResult: string | null;
}
