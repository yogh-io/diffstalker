import { useState, useCallback, useEffect } from 'react';
import { isAIAvailable, generateCommitMessage } from '../ai/commit.js';
import { validateCommit, formatCommitMessage } from '../services/commitService.js';

export interface UseCommitFlowResult {
  // State
  message: string;
  amend: boolean;
  isCommitting: boolean;
  isGenerating: boolean;
  error: string | null;
  inputFocused: boolean;
  aiAvailable: boolean;

  // Actions
  setMessage: (message: string) => void;
  toggleAmend: () => void;
  setInputFocused: (focused: boolean) => void;
  handleGenerate: () => Promise<void>;
  handleSubmit: () => Promise<void>;
  reset: () => void;
}

export interface UseCommitFlowOptions {
  stagedCount: number;
  stagedDiff: string;
  onCommit: (message: string, amend: boolean) => Promise<void>;
  onSuccess: () => void;
  getHeadMessage: () => Promise<string>;
}

/**
 * Hook that manages the commit flow state and logic.
 * Extracted from CommitPanel to separate concerns.
 */
export function useCommitFlow(options: UseCommitFlowOptions): UseCommitFlowResult {
  const { stagedCount, stagedDiff, onCommit, onSuccess, getHeadMessage } = options;

  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);

  const aiAvailable = isAIAvailable();

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

  const handleGenerate = useCallback(async () => {
    if (!aiAvailable || isGenerating) return;

    setIsGenerating(true);
    setError(null);

    try {
      const generated = await generateCommitMessage(stagedDiff);
      setMessage(generated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, [aiAvailable, isGenerating, stagedDiff]);

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
    isGenerating,
    error,
    inputFocused,
    aiAvailable,
    setMessage,
    toggleAmend,
    setInputFocused,
    handleGenerate,
    handleSubmit,
    reset,
  };
}
