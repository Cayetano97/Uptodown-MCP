import * as z from 'zod/v4';
import { READ_ONLY, WRITE_DESTRUCTIVE_IDEMPOTENT, asArray, asRecord, countLabel, createToolRegistrar, jsonText, mutationText, pickString } from './shared.js';
/** Account-level tools: session probe, profile, reference data. */
export function registerAccountTools(server, client) {
    const tool = createToolRegistrar(server, client);
    tool('whoami', {
        title: 'Who am I',
        description: 'Returns the profile of the author signed in to the Uptodown Developers Console. Useful as a session/credentials smoke check.',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
    }, async () => {
        const response = await client.get('/developers/author/logged-data');
        const name = pickString(asRecord(response.data), 'name');
        return jsonText(name === null ? 'Signed in to the Uptodown Developers Console.' : `Signed in as ${name}.`, response.data);
    });
    tool('update_profile_name', {
        title: 'Update profile name',
        description: 'Updates the display name of the signed-in author profile (PUT /developers/author). ' +
            'The name is public: it becomes the author name shown on every app, description and comment you publish.',
        inputSchema: z.object({
            name: z.string().min(1).describe('New display name for the author profile'),
        }),
        annotations: WRITE_DESTRUCTIVE_IDEMPOTENT,
    }, async (args) => {
        const response = await client.putJson('/developers/author', { name: args.name });
        return mutationText(`Profile name updated to "${args.name}".`, response);
    });
    tool('list_languages', {
        title: 'List languages',
        description: 'Lists Uptodown languages with their IDs. Use the returned languageID values for descriptions, screenshots and release notes. ' +
            'scope "all" reads /developers/languages, scope "active" reads /developers/active-languages.',
        inputSchema: z.object({
            scope: z
                .enum(['all', 'active'])
                .optional()
                .describe('"all" (default) for every language, "active" for the console\'s active language list'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const scope = args.scope ?? 'all';
        const response = scope === 'active'
            ? await client.get('/developers/active-languages')
            : await client.get('/developers/languages');
        const languages = asArray(response.data);
        return jsonText(`Languages (scope: ${scope}): ${countLabel(languages.length, 'entry', 'entries')} returned.`, response.data);
    });
}
