import * as z from 'zod/v4';
import { sha256File } from '../client.js';
import { assertUploadPathAllowed } from '../file-root.js';
import { READ_ONLY, WRITE, WRITE_DESTRUCTIVE, WRITE_IDEMPOTENT, asArray, asRecord, countLabel, createToolRegistrar, jsonText, mutationText } from './shared.js';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SHA256_HINT = 'Lowercase or uppercase hex sha256 of the file (64 characters)';
/** File and version tools. */
export function registerFileTools(server, client) {
    const tool = createToolRegistrar(server, client);
    tool('check_file_hash', {
        title: 'Check file hash',
        description: 'Checks whether a file with this sha256 already exists on Uptodown ' +
            '(GET /developers/file/check-exists-sha256), which is how the console detects duplicates before uploading. ' +
            'Provide either "sha256" directly or "filePath" to hash a local file, not both. "Not found" is a normal answer, not an error.',
        inputSchema: z.object({
            sha256: z.string().regex(SHA256_PATTERN).optional().describe(SHA256_HINT),
            filePath: z.string().min(1).optional().describe('Absolute path of a local file to hash and check'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const sha256 = await resolveSha256(args.sha256, args.filePath);
        const response = await client.request({
            method: 'GET',
            path: '/developers/file/check-exists-sha256',
            query: { sha256 },
            allowEnvelopeFailure: true,
        });
        const exists = response.envelope?.success === 1 && response.data !== undefined && response.data !== null;
        return jsonText(exists
            ? `A file with sha256 ${sha256} already exists on Uptodown.`
            : `No file with sha256 ${sha256} exists on Uptodown yet.`, exists ? response.data : { sha256, exists: false });
    });
    tool('upload_app_file', {
        title: 'Upload app file',
        description: 'Uploads a new app version file (POST /developers/file/add-from-upload). ' +
            'The sha256 is computed locally and sent with the file, exactly like the console does. ' +
            'Any warnings returned by Uptodown (for example signature or version checks) are surfaced in the result.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            filePath: z.string().min(1).describe('Absolute path of the APK/XAPK/AAB file to upload'),
            version: z
                .string()
                .optional()
                .describe('Version name to attach to the upload (for example "1.4.2"); omitted when not provided'),
        }),
        annotations: WRITE,
    }, async (args) => {
        assertUploadPathAllowed(args.filePath);
        const sha256 = await sha256File(args.filePath);
        const form = {
            appID: args.appID,
            sha256,
            ...(args.version === undefined ? {} : { version: args.version }),
        };
        const response = await client.postForm('/developers/file/add-from-upload', form, [
            { field: 'file', path: args.filePath },
        ]);
        const warnings = extractWarnings(response.data);
        const filename = basename(args.filePath);
        const summary = warnings.length === 0
            ? `Uploaded ${filename} for app ${args.appID} (sha256 ${sha256}).`
            : `Uploaded ${filename} for app ${args.appID} (sha256 ${sha256}) with ${countLabel(warnings.length, 'warning')}: ${warnings.join(' | ')}`;
        return mutationText(summary, response);
    });
    tool('add_file_from_url', {
        title: 'Add file from URL (synchronous)',
        description: 'Asks Uptodown to fetch an app file from a remote URL (POST /developers/file/add-from-url). ' +
            'The console sends this as a multipart form with controller=file, op=urlToFiles and the URL base64-encoded ' +
            'in downloadURL; this tool does the same. Uptodown downloads and processes the file server-side.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            url: z.url().describe('Public URL of the file Uptodown should download'),
            version: z.string().optional().describe('Version name to attach to the upload'),
            useProxy: z.boolean().optional().describe('Send the request through the Uptodown proxy (adds useProxy=1)'),
        }),
        annotations: WRITE,
    }, async (args) => {
        const form = {
            appID: args.appID,
            controller: 'file',
            op: 'urlToFiles',
            downloadURL: Buffer.from(args.url, 'utf8').toString('base64'),
            ...(args.version === undefined ? {} : { version: args.version }),
            ...(args.useProxy === true ? { useProxy: '1' } : {}),
        };
        const response = await client.postForm('/developers/file/add-from-url', form);
        return mutationText(`URL submitted for app ${args.appID}: Uptodown will download and process ${args.url}.`, response);
    });
    tool('add_file_from_url_async', {
        title: 'Add file from URL (asynchronous)',
        description: 'Queues a remote-URL file import without waiting for it (POST /developers/file/add-from-url-async, JSON {url, useProxy}). ' +
            'The response includes the unix timestamp (seconds) that the console uses to correlate the job; ' +
            'pass it to check_async_status together with the sha256 of the file to poll progress.',
        inputSchema: z.object({
            url: z.url().describe('Public URL of the file Uptodown should download'),
            useProxy: z.boolean().optional().describe('Send the request through the Uptodown proxy (sent as useProxy 1/0)'),
        }),
        annotations: WRITE,
    }, async (args) => {
        const useProxy = args.useProxy === true ? 1 : 0;
        const time = Math.round(Date.now() / 1000);
        const response = await client.postJson('/developers/file/add-from-url-async', { url: args.url, useProxy });
        return jsonText(`Async URL import queued for ${args.url} (time=${time}). Poll with check_async_status.`, { request: { url: args.url, useProxy }, time, response: response.body });
    });
    tool('check_async_status', {
        title: 'Check async upload status',
        description: 'Polls an asynchronous upload job (GET /developers/file/async-status?sha256=&time=&url=). ' +
            'The API answers 204 while the job is still pending and returns the job payload once it has a result. ' +
            '"time" is the unix timestamp in seconds captured when the async upload started, as the console does.',
        inputSchema: z.object({
            sha256: z.string().regex(SHA256_PATTERN).describe(SHA256_HINT),
            time: z.coerce.number().int().positive().describe('Unix timestamp in seconds of the async upload start'),
            url: z.string().optional().describe('Source URL, when the job came from a remote URL import'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get('/developers/file/async-status', {
            sha256: args.sha256,
            time: args.time,
            url: args.url,
        });
        if (response.empty) {
            return jsonText(`Async job still pending (204) for sha256 ${args.sha256} at time ${args.time}.`, {
                pending: true,
                sha256: args.sha256,
                time: args.time,
            });
        }
        return jsonText(`Async job answered for sha256 ${args.sha256} at time ${args.time}.`, response.body);
    });
    tool('save_file_metadata', {
        title: 'Save file metadata',
        description: 'Updates the version metadata of an uploaded file (POST /developers/author/file/save): ' +
            'version name, development phase, minimum and maximum supported SDK levels.',
        inputSchema: z.object({
            fileID: z.coerce.number().int().positive().describe('Version file ID'),
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            version: z.string().min(1).describe('Version name shown to users (for example "1.4.2")'),
            phaseID: z.coerce.number().int().min(0).describe('Development phase ID'),
            minSDK: z.coerce.number().int().min(0).describe('Minimum supported Android SDK level'),
            maxSDK: z.coerce.number().int().min(0).describe('Maximum supported Android SDK level'),
        }),
        annotations: WRITE_IDEMPOTENT,
    }, async (args) => {
        const response = await client.postForm('/developers/author/file/save', {
            fileID: args.fileID,
            appID: args.appID,
            version: args.version,
            phaseID: args.phaseID,
            minSDK: args.minSDK,
            maxSDK: args.maxSDK,
        });
        return mutationText(`Metadata saved for file ${args.fileID} of app ${args.appID} (version "${args.version}").`, response);
    });
    tool('delete_app_file', {
        title: 'Delete app file',
        description: 'Deletes one uploaded version file from an app (POST /developers/app/file/delete). Destructive and irreversible.',
        inputSchema: z.object({
            fileID: z.coerce.number().int().positive().describe('Version file ID to delete'),
            appID: z.coerce.number().int().positive().describe('Numeric app ID the file belongs to'),
        }),
        annotations: WRITE_DESTRUCTIVE,
    }, async (args) => {
        const response = await client.postForm('/developers/app/file/delete', {
            fileID: args.fileID,
            appID: args.appID,
        });
        return mutationText(`File ${args.fileID} deleted from app ${args.appID}.`, response);
    });
}
async function resolveSha256(sha256, filePath) {
    const hasSha256 = sha256 !== undefined && sha256 !== '';
    const hasFilePath = filePath !== undefined && filePath !== '';
    if (hasSha256 && hasFilePath) {
        throw new Error('Provide either "sha256" or "filePath", not both — "filePath" would be hashed locally and "sha256" ignored.');
    }
    if (hasSha256)
        return sha256.toLowerCase();
    if (hasFilePath) {
        assertUploadPathAllowed(filePath);
        return sha256File(filePath);
    }
    throw new Error('Provide either "sha256" (hex digest) or "filePath" (local file to hash).');
}
function extractWarnings(data) {
    const warnings = asRecord(data)?.['warnings'];
    return asArray(warnings).map((warning) => typeof warning === 'string' ? warning : JSON.stringify(warning));
}
function basename(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}
