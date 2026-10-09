import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { UptodownApiError, type ApiResponse, type UptodownClient } from '../client.js';

/** Shape accepted by `inputSchema`; mirrors the SDK's own `ZodRawShape`. */
export type ToolShape = Record<string, z.ZodType>;

/**
 * Optional integer that treats `""` as "not provided".
 *
 * MCP clients commonly send `""` for an omitted number; `z.coerce.number()` alone would turn it
 * into `0` and the API would receive a real filter (for example `platformID=0`). A real `0` still
 * goes through as the caller's explicit choice.
 */
export function optionalNumberParam(): z.ZodType<number | undefined> {
  return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().optional());
}

export type ToolHandler<Shape extends ToolShape> = (
  args: z.infer<z.ZodObject<Shape>>,
) => string | Promise<string>;

export interface ToolConfig<Shape extends ToolShape> {
  title: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  /** Safety hints (MCP `ToolAnnotations`) forwarded verbatim to the SDK registration. */
  annotations?: ToolAnnotations;
}

/** Annotation sets shared by the tool registrations.
 *
 * `readOnlyHint` covers the 16 read-only tools; `destructiveHint` marks the five that cannot be
 * undone. `idempotentHint` separates "same call, same state" saves from calls that add, queue or
 * publish on every invocation; every mutating tool is open-world because it talks to the API. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
export const WRITE: ToolAnnotations = { openWorldHint: true, idempotentHint: false };
export const WRITE_IDEMPOTENT: ToolAnnotations = { openWorldHint: true, idempotentHint: true };
export const WRITE_DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: false,
};
export const WRITE_DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = {
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: true,
};

/**
 * Registers a tool that answers with one text block.
 *
 * Every failure becomes an `isError` result: missing credentials return the configuration hint,
 * API errors keep the `Uptodown API error [code]: message` contract, and anything unexpected is
 * reported without a stack dump. Errors are redacted before they reach the model.
 */
export function createToolRegistrar(server: McpServer, client: UptodownClient) {
  return function registerTool<Shape extends ToolShape>(
    name: string,
    config: ToolConfig<Shape>,
    handler: ToolHandler<Shape>,
  ): void {
    server.registerTool(name, config, async (args) => {
      const configurationError = client.configurationError;
      if (configurationError !== null) {
        return errorResult(configurationError);
      }
      try {
        return textResult(await handler(args));
      } catch (error) {
        // Keep the stack on stderr (redacted) so a failure is debuggable without leaking.
        if (error instanceof Error && error.stack !== undefined) {
          process.stderr.write(`[uptodown-mcp] ${name} failed: ${client.redact(error.stack)}\n`);
        }
        return errorResult(client.redact(describeError(error)));
      }
    });
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Hard ceiling for one tool response; longer payloads are cut and marked (see {@linkcode jsonText}). */
export const MAX_PAYLOAD_CHARS = 100_000;

/**
 * One-line summary, a blank line, then the compact JSON payload.
 *
 * The whole text is capped at {@linkcode MAX_PAYLOAD_CHARS} so one oversized API answer cannot
 * flood the client; a truncated result ends with an explicit marker telling the model to refine.
 */
export function jsonText(summary: string, value: unknown): string {
  return capPayload(`${summary}\n\n${renderJson(value)}`);
}

/** Mutation result: the full API envelope, or an honest note when the API sent no body. */
export function mutationText(summary: string, response: ApiResponse): string {
  const payload = response.body ?? { httpStatus: response.status, body: null };
  return jsonText(summary, payload);
}

function capPayload(text: string): string {
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  const marker = `… [truncated: showing ${MAX_PAYLOAD_CHARS} of ${text.length} characters — refine the request (filters/limits) for the full result]`;
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}${marker}`;
}

function renderJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  } catch {
    return String(value);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof UptodownApiError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function pickString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
