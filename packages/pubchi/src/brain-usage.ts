type BrainMessage = { role: string; content: string };

export function estimateBrainTokens(messages: BrainMessage[], output?: string): number {
  const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
  const outputChars = output?.length ?? 0;
  return Math.max(1, Math.ceil(promptChars / 4) + Math.ceil(outputChars / 4));
}
