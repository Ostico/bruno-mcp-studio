interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
}

/** The text parts of an MCP tool result, joined. */
export function textOf(result: unknown): string {
  const content = (result as ToolResult).content ?? [];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}
