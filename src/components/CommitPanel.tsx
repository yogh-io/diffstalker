import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCommitFlow } from '../hooks/useCommitFlow.js';

interface CommitPanelProps {
  isActive: boolean;
  stagedCount: number;
  stagedDiff: string;
  onCommit: (message: string, amend: boolean) => Promise<void>;
  onCancel: () => void;
  getHeadMessage: () => Promise<string>;
  onInputFocusChange?: (focused: boolean) => void;
}

export function CommitPanel({
  isActive,
  stagedCount,
  stagedDiff,
  onCommit,
  onCancel,
  getHeadMessage,
  onInputFocusChange,
}: CommitPanelProps): React.ReactElement {
  const {
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
  } = useCommitFlow({
    stagedCount,
    stagedDiff,
    onCommit,
    onSuccess: onCancel,
    getHeadMessage,
  });

  // Notify parent of focus state changes
  useEffect(() => {
    onInputFocusChange?.(inputFocused);
  }, [inputFocused, onInputFocusChange]);

  // Keyboard handling
  useInput((input, key) => {
    if (!isActive) return;

    // When input is focused, Escape unfocuses it (but stays on commit tab)
    // When input is unfocused, Escape cancels and goes back to diff
    if (key.escape) {
      if (inputFocused) {
        setInputFocused(false);
      } else {
        onCancel();
      }
      return;
    }

    // When input is unfocused, allow refocusing with 'i' or Enter
    if (!inputFocused) {
      if (input === 'i' || key.return) {
        setInputFocused(true);
        return;
      }
      // Toggle amend with 'a' when unfocused
      if (input === 'a') {
        toggleAmend();
        return;
      }
      // Generate with 'g' when unfocused
      if (input === 'g' && aiAvailable) {
        handleGenerate();
        return;
      }
      return; // Don't handle other keys - let them bubble up to useKeymap
    }

    // When input is focused, only handle special keys
    // Toggle amend with 'a' when message is empty
    if (input === 'a' && !message) {
      toggleAmend();
      return;
    }

    // Generate with 'g' when message is empty
    if (input === 'g' && !message && aiAvailable) {
      handleGenerate();
      return;
    }
  }, { isActive });

  if (!isActive) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Press '2' or 'c' to open commit panel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Commit Message</Text>
        {amend && <Text color="yellow"> (amending)</Text>}
      </Box>

      <Box borderStyle="round" borderColor={inputFocused ? 'cyan' : undefined} paddingX={1}>
        {inputFocused ? (
          <TextInput
            value={message}
            onChange={setMessage}
            onSubmit={handleSubmit}
            placeholder="Enter commit message..."
          />
        ) : (
          <Text dimColor={!message}>{message || 'Press i or Enter to edit...'}</Text>
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text color={amend ? 'green' : 'gray'}>[{amend ? 'x' : ' '}] Amend</Text>
        <Text dimColor>(a)</Text>
        {aiAvailable && (
          <>
            <Text color="cyan">[g] Generate</Text>
            {isGenerating && <Text color="yellow">generating...</Text>}
          </>
        )}
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {isCommitting && (
        <Box marginTop={1}>
          <Text color="yellow">Committing...</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Staged: {stagedCount} file(s) | {inputFocused ? 'Enter: commit | Esc: unfocus' : 'i/Enter: edit | Esc: cancel | 1/3: switch tab'}
          {aiAvailable && ' | g: AI generate'}
        </Text>
      </Box>
    </Box>
  );
}
