/** Cheap token estimate. Good enough for budgeting; avoids shipping a tokenizer. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
