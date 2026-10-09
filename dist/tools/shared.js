import * as z from 'zod/v4';
import { UptodownApiError } from '../client.js';
/**
 * Optional integer that treats `""` as "not provided".
 *
 * MCP clients commonly send `""` for an omitted number; `z.coerce.number()` alone would turn it
 * into `0` and the API would receive a real filter (for example `platformID=0`). A real `0` still
 * goes through as the caller's explicit choice.
 */
export function optionalNumberParam() {
    return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().optional());
}
/** Annotation sets shared by the tool registrations.
 *
 * `readOnlyHint` covers the 16 read-only tools; `destructiveHint` marks the five that cannot be
 * undone. `idempotentHint` separates "same call, same state" saves from calls that add, queue or
 * publish on every invocation; every mutating tool is open-world because it talks to the API. */
export const READ_ONLY = { readOnlyHint: true };
export const WRITE = { openWorldHint: true, idempotentHint: false };
export const WRITE_IDEMPOTENT = { openWorldHint: true, idempotentHint: true };
export const WRITE_DESTRUCTIVE = {
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
};
export const WRITE_DESTRUCTIVE_IDEMPOTENT = {
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
export function createToolRegistrar(server, client) {
    return function registerTool(name, config, handler) {
        server.registerTool(name, config, async (args) => {
            const configurationError = client.configurationError;
            if (configurationError !== null) {
                return errorResult(configurationError);
            }
            try {
                return textResult(await handler(args));
            }
            catch (error) {
                // Keep the stack on stderr (redacted) so a failure is debuggable without leaking.
                if (error instanceof Error && error.stack !== undefined) {
                    process.stderr.write(`[uptodown-mcp] ${name} failed: ${client.redact(error.stack)}\n`);
                }
                return errorResult(client.redact(describeError(error)));
            }
        });
    };
}
export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
export function errorResult(text) {
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
export function jsonText(summary, value) {
    return capPayload(`${summary}\n\n${renderJson(value)}`);
}
/** Mutation result: the full API envelope, or an honest note when the API sent no body. */
export function mutationText(summary, response) {
    const payload = response.body ?? { httpStatus: response.status, body: null };
    return jsonText(summary, payload);
}
function capPayload(text) {
    if (text.length <= MAX_PAYLOAD_CHARS)
        return text;
    const marker = `… [truncated: showing ${MAX_PAYLOAD_CHARS} of ${text.length} characters — refine the request (filters/limits) for the full result]`;
    return `${text.slice(0, MAX_PAYLOAD_CHARS)}${marker}`;
}
function renderJson(value) {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? 'null' : json;
    }
    catch {
        return String(value);
    }
}
export function describeError(error) {
    if (error instanceof UptodownApiError)
        return error.message;
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
export function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    return value;
}
export function pickString(record, key) {
    const value = record?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
}
export function countLabel(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
