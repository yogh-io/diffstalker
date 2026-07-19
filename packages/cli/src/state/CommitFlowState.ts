import { EventEmitter } from 'node:events';
import { validateCommit, formatCommitMessage } from '../services/commitService.js';

export interface CommitFlowStateData {
  message: string;
  amend: boolean;
  isCommitting: boolean;
  error: string | null;
  inputFocused: boolean;
}

type CommitFlowEventMap = {
  change: [CommitFlowStateData];
  'focus-change': [boolean];
  submit: [];
  cancel: [];
};

const DEFAULT_STATE: CommitFlowStateData = {
  message: '',
  amend: false,
  isCommitting: false,
  error: null,
  inputFocused: false,
};

/**
 * CommitFlowState manages commit panel state independently of React.
 */
export class CommitFlowState extends EventEmitter<CommitFlowEventMap> {
  private _state: CommitFlowStateData = { ...DEFAULT_STATE };
  private getHeadMessage: () => Promise<string>;
  private onCommit: (message: string, amend: boolean) => Promise<void>;
  private onSuccess: () => void;
  private stagedCount: number = 0;

  constructor(options: {
    getHeadMessage: () => Promise<string>;
    onCommit: (message: string, amend: boolean) => Promise<void>;
    onSuccess: () => void;
  }) {
    super();
    this.getHeadMessage = options.getHeadMessage;
    this.onCommit = options.onCommit;
    this.onSuccess = options.onSuccess;
  }

  get state(): CommitFlowStateData {
    return this._state;
  }

  private update(partial: Partial<CommitFlowStateData>): void {
    this._state = { ...this._state, ...partial };
    this.emit('change', this._state);
  }

  setStagedCount(count: number): void {
    this.stagedCount = count;
  }

  setMessage(message: string): void {
    this.update({ message, error: null });
  }

  setInputFocused(focused: boolean): void {
    this.update({ inputFocused: focused });
    this.emit('focus-change', focused);
  }

  async toggleAmend(): Promise<void> {
    const newAmend = !this._state.amend;
    this.update({ amend: newAmend });

    // Load HEAD message when amend is enabled
    if (newAmend && !this._state.message) {
      try {
        const msg = await this.getHeadMessage();
        if (msg) {
          this.update({ message: msg });
        }
      } catch {
        // Ignore errors
      }
    }
  }

  async submit(): Promise<void> {
    const validation = validateCommit(this._state.message, this.stagedCount, this._state.amend);
    if (!validation.valid) {
      this.update({ error: validation.error });
      return;
    }

    this.update({ isCommitting: true, error: null });

    try {
      await this.onCommit(formatCommitMessage(this._state.message), this._state.amend);
      this.update({
        message: '',
        amend: false,
        isCommitting: false,
        inputFocused: false,
      });
      this.onSuccess();
    } catch (err) {
      this.update({
        isCommitting: false,
        error: err instanceof Error ? err.message : 'Commit failed',
      });
    }
  }

  reset(): void {
    this._state = { ...DEFAULT_STATE };
    this.emit('change', this._state);
  }
}
