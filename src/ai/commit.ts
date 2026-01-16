import Anthropic from '@anthropic-ai/sdk';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (anthropicClient) return anthropicClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

export function isAIAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function generateCommitMessage(stagedDiff: string): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  if (!stagedDiff.trim()) {
    throw new Error('No staged changes to generate message for');
  }

  // Truncate very long diffs to avoid hitting token limits
  const maxDiffLength = 8000;
  const truncatedDiff = stagedDiff.length > maxDiffLength
    ? stagedDiff.slice(0, maxDiffLength) + '\n\n... (diff truncated)'
    : stagedDiff;

  try {
    const response = await client.messages.create({
      model: process.env.DIFFSTALKER_AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Generate a concise git commit message for these staged changes. Follow conventional commit format if appropriate. Include a brief subject line (max 50 chars) and optionally a body with more details. Do not include any markdown formatting or code blocks - just the plain commit message text.

Staged changes:
\`\`\`
${truncatedDiff}
\`\`\``,
      }],
    });

    if (response.content[0].type !== 'text') {
      throw new Error('Unexpected response format');
    }

    return response.content[0].text.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AI generation failed: ${error.message}`);
    }
    throw error;
  }
}
