import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { isAIAvailable, generateCommitMessage } from '../ai/commit.js';

interface CommitPanelProps {
  isActive: boolean;
  stagedCount: number;
  stagedDiff: string;
  onCommit: (message: string, amend: boolean) => Promise<void>;
  onCancel: () => void;
  getHeadMessage: () => Promise<string>;
}

export function CommitPanel({
  isActive,
  stagedCount,
  stagedDiff,
  onCommit,
  onCancel,
  getHeadMessage,
}: CommitPanelProps): React.ReactElement {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiAvailable = isAIAvailable();

  // Load HEAD message when amend is toggled
  useEffect(() => {
    if (amend) {
      getHeadMessage().then(msg => {
        if (msg && !message) {
          setMessage(msg);
        }
      });
    }
  }, [amend]);

  const handleGenerate = async () => {
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
  };

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      onCancel();
      return;
    }

    // Toggle amend with 'a' when message is empty
    if (input === 'a' && !message) {
      setAmend(!amend);
      return;
    }

    // Generate with 'g' when message is empty
    if (input === 'g' && !message && aiAvailable) {
      handleGenerate();
      return;
    }
  }, { isActive });

  const handleSubmit = async (value: string) => {
    if (!value.trim()) {
      setError('Commit message cannot be empty');
      return;
    }

    if (stagedCount === 0 && !amend) {
      setError('No changes staged for commit');
      return;
    }

    setIsCommitting(true);
    setError(null);

    try {
      await onCommit(value.trim(), amend);
      setMessage('');
      setAmend(false);
      onCancel(); // Switch back to diff view
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setIsCommitting(false);
    }
  };

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

      <Box borderStyle="round" paddingX={1}>
        <TextInput
          value={message}
          onChange={setMessage}
          onSubmit={handleSubmit}
          placeholder="Enter commit message..."
        />
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
          Staged: {stagedCount} file(s) | Enter: commit | Esc: cancel
          {aiAvailable && ' | g: AI generate'}
        </Text>
      </Box>
    </Box>
  );
}
