import { useState, useCallback, useEffect } from 'react';
import { validateCommit, formatCommitMessage } from '../services/commitService.js';

export interface UseCommitFlowResult {
  // State
  message: string;
  amend: boolean;
  isCommitting: boolean;
  error: string | null;
  inputFocused: boolean;

  // Actions
  setMessage: (message: string) => void;
  toggleAmend: () => void;
  setInputFocused: (focused: boolean) => void;
  handleSubmit: () => Promise<void>;
  reset: () => void;
}

export interface UseCommitFlowOptions {
  stagedCount: number;
  onCommit: (message: string, amend: boolean) => Promise<void>;
  onSuccess: () => void;
  getHeadMessage: () => Promise<string>;
}

/**
 * Hook that manages the commit flow state and logic.
 * Extracted from CommitPanel to separate concerns.
 */
export function useCommitFlow(options: UseCommitFlowOptions): UseCommitFlowResult {
  const { stagedCount, onCommit, onSuccess, getHeadMessage } = options;

  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);

  // Load HEAD message when amend is toggled
  useEffect(() => {
    if (amend) {
      getHeadMessage().then((msg) => {
        if (msg && !message) {
          setMessage(msg);
        }
      });
    }
  }, [amend, getHeadMessage]);

  const toggleAmend = useCallback(() => {
    setAmend((prev) => !prev);
  }, []);

  const handleSubmit = useCallback(async () => {
    const validation = validateCommit(message, stagedCount, amend);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }

    setIsCommitting(true);
    setError(null);

    try {
      await onCommit(formatCommitMessage(message), amend);
      setMessage('');
      setAmend(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setIsCommitting(false);
    }
  }, [message, stagedCount, amend, onCommit, onSuccess]);

  const reset = useCallback(() => {
    setMessage('');
    setAmend(false);
    setError(null);
    setInputFocused(false);
  }, []);

  return {
    message,
    amend,
    isCommitting,
    error,
    inputFocused,
    setMessage,
    toggleAmend,
    setInputFocused,
    handleSubmit,
    reset,
  };
}
