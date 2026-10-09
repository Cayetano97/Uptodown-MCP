import * as z from 'zod/v4';
import { UptodownApiError } from '../client.js';
import { READ_ONLY, asArray, asRecord, countLabel, createToolRegistrar, jsonText, optionalNumberParam } from './shared.js';
/** App lookup and inventory tools. */
export function registerAppTools(server, client) {
    const tool = createToolRegistrar(server, client);
    tool('list_my_apps', {
        title: 'List my apps',
        description: 'Lists the apps of your own author profile, exactly like the console\'s apps table ' +
            '(GET /developers/author/organization/apps). "query" filters by app name and "page" pages the table ' +
            '(starting at 1); the summary also reports your total app count (GET /developers/author/total-apps). ' +
            'Use this to get appIDs; list_apps shows the console app table instead, which on accounts with ' +
            'review access is the platform review queue.',
        inputSchema: z.object({
            page: z
                .preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(1).optional())
                .describe('Page number, starting at 1 (default 1)'),
            query: z.string().optional().describe('Filter by app name (case-insensitive substring)'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const page = args.page ?? 1;
        const query = args.query === undefined || args.query.trim() === '' ? undefined : args.query.trim();
        let apps = [];
        let pastLastPage = false;
        try {
            const response = await client.get('/developers/author/organization/apps', { page, query });
            apps = asArray(response.data);
        }
        catch (error) {
            // 404 means "no apps on this page" (empty profile or past the last page), not a failure.
            if (error instanceof UptodownApiError && error.status === 404) {
                pastLastPage = true;
            }
            else {
                throw error;
            }
        }
        // Informative only: a missing total never fails the list.
        let total = null;
        try {
            const totalResponse = await client.get('/developers/author/total-apps');
            const value = asRecord(totalResponse.data)?.['total'];
            if (typeof value === 'number' && Number.isFinite(value))
                total = value;
        }
        catch {
            total = null;
        }
        const filter = query === undefined ? '' : ` matching "${query}"`;
        const summary = total === null
            ? `My apps${filter} (page ${page}): ${countLabel(apps.length, 'app')} returned.`
            : `My apps${filter} (page ${page}): ${countLabel(apps.length, 'app')} returned of ${total} total.`;
        const payload = apps.length === 0 ? { page, query: query ?? null, apps: [] } : apps;
        return jsonText(pastLastPage && apps.length === 0 ? `No apps on page ${page} (you may be past the last page).` : summary, payload);
    });
    tool('list_apps', {
        title: 'List console apps (filterable)',
        description: 'Lists the console app table (GET /developers/author/app/list) with the same filter panel the console offers. ' +
            'On accounts with review access this table is the platform review queue (apps pending revision), ' +
            'not your own apps — use list_my_apps for those. All filters are optional; omit them to list everything. ' +
            'Returns the raw app objects, including the app ID and packagename used by the other tools.',
        inputSchema: z.object({
            platformID: optionalNumberParam().describe('Platform filter (console platformID)'),
            languageID: optionalNumberParam().describe('Language filter (languageID)'),
            country: z.string().optional().describe('Country filter as used by the console (for example "ES")'),
            withAuthor: z
                .enum(['1', '3'])
                .optional()
                .describe('"1" for apps with an author, "3" for preregistered apps'),
            autoinsert: z.enum(['1', '0']).optional().describe('"1" for apps with autoinsert, "0" without'),
            type: z
                .enum(['new', 'image', 'updated', 'description', 'video'])
                .optional()
                .describe('App state filter used by the console dropdown'),
            order: z
                .enum(['download-desc', 'download-asc', 'date-desc', 'date-asc', 'name-desc', 'name-asc'])
                .optional()
                .describe('Sort order used by the console dropdown'),
            organizationWithPublishedApps: z
                .string()
                .optional()
                .describe('Organization ID filter; only sent when set (the console omits "0")'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get('/developers/author/app/list', {
            platformID: args.platformID,
            languageID: args.languageID,
            country: args.country,
            withAuthor: args.withAuthor,
            autoinsert: args.autoinsert,
            type: args.type,
            order: args.order,
            organizationWithPublishedApps: args.organizationWithPublishedApps === undefined || args.organizationWithPublishedApps === '0'
                ? undefined
                : args.organizationWithPublishedApps,
        });
        const apps = asArray(response.data);
        return jsonText(`Apps: ${countLabel(apps.length, 'app')} returned.`, response.data);
    });
    tool('find_app_by_package', {
        title: 'Find app by package name',
        description: 'Looks up an app by its Android package name (GET /developers/search/app/list?packagename=...). ' +
            'An empty result means no app of yours matches that package name.',
        inputSchema: z.object({
            packagename: z.string().min(1).describe('Android package name, for example "com.example.app"'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get('/developers/search/app/list', { packagename: args.packagename });
        const apps = asArray(response.data);
        return jsonText(apps.length === 0
            ? `No app found for package "${args.packagename}".`
            : `Apps matching package "${args.packagename}": ${countLabel(apps.length, 'match', 'matches')}.`, response.data);
    });
    tool('search_apps', {
        title: 'Search apps by name',
        description: 'Searches apps by name (GET /developers/get-apps-by-name?name=...). ' +
            'Useful to resolve an app name to its appID. A 204 answer means there are no matches.',
        inputSchema: z.object({
            name: z.string().min(1).describe('App name or name fragment to search for'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get('/developers/get-apps-by-name', { name: args.name });
        const apps = asArray(response.data);
        return jsonText(apps.length === 0 ? `No app matched "${args.name}".` : `Search "${args.name}": ${countLabel(apps.length, 'match', 'matches')}.`, response.data);
    });
    tool('get_app_icon', {
        title: 'Get app icon',
        description: 'Returns the icon information currently set for an app (GET /developers/app/{appID}/icon). ' +
            'A 204 answer means the app has no icon yet.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get(`/developers/app/${args.appID}/icon`);
        if (response.empty || response.data === null || response.data === undefined) {
            return jsonText(`App ${args.appID} has no icon set.`, { appID: args.appID, icon: null });
        }
        return jsonText(`Icon information for app ${args.appID}.`, response.data);
    });
    tool('get_app_media_summary', {
        title: 'Get app media summary',
        description: 'Returns the per-language screenshot and video inventory of an app ' +
            '(GET /developers/screenshot-video-author/{appID}), including how many items each language has.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get(`/developers/screenshot-video-author/${args.appID}`);
        const languages = asArray(response.data);
        return jsonText(`Media inventory for app ${args.appID}: ${countLabel(languages.length, 'language entry', 'language entries')}.`, response.data);
    });
}
