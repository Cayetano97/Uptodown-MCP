import * as z from 'zod/v4';
import { READ_ONLY, asArray, countLabel, createToolRegistrar, jsonText, optionalNumberParam } from './shared.js';
/**
 * Daily downloads come from one of the three verified console endpoints
 * `stats/downloads/daily-platform`, `daily-language` and `daily-country`
 * (there is no plain `stats/downloads/daily` in the console bundle).
 */
const DAILY_PATHS = {
    platform: '/developers/stats/downloads/daily-platform',
    language: '/developers/stats/downloads/daily-language',
    country: '/developers/stats/downloads/daily-country',
};
/**
 * Summary tables. Only `app-summary-table` accepts filters (platformID and directoryID[]);
 * the other three are parameterless in the console bundle.
 */
const SUMMARY_PATHS = {
    apps: '/developers/stats/downloads/app-summary-table',
    platforms: '/developers/stats/downloads/platform-summary-table',
    languages: '/developers/stats/downloads/language-summary-table',
    countries: '/developers/stats/downloads/country-summary-table',
};
/** Download statistics tools. */
export function registerStatsTools(server, client) {
    const tool = createToolRegistrar(server, client);
    tool('get_downloads_daily', {
        title: 'Get daily downloads',
        description: 'Returns the daily download series between two dates, grouped by platform, language or country ' +
            '(GET /developers/stats/downloads/daily-platform|daily-language|daily-country). ' +
            'The console sends the range as unix seconds; ISO 8601 dates are accepted here and converted.',
        inputSchema: z.object({
            since: z
                .coerce.string()
                .describe('Range start: ISO 8601 date ("2026-09-01") or unix seconds ("1756684800")'),
            until: z.coerce.string().describe('Range end: ISO 8601 date or unix seconds'),
            groupBy: z
                .enum(['platform', 'language', 'country'])
                .optional()
                .describe('Breakdown dimension (default "platform")'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const groupBy = args.groupBy ?? 'platform';
        const since = toEpochSeconds(args.since);
        const until = toEpochSeconds(args.until);
        const response = await client.get(DAILY_PATHS[groupBy], { since, until });
        const series = asArray(response.data);
        return jsonText(`Daily downloads by ${groupBy} from ${describeRange(since)} to ${describeRange(until)}: ${countLabel(series.length, 'entry', 'entries')}.`, response.data);
    });
    tool('get_downloads_summary', {
        title: 'Get downloads summary',
        description: 'Returns a downloads summary table (GET /developers/stats/downloads/{scope}-summary-table). ' +
            'scope "apps" uses app-summary-table and accepts platformID plus directoryIDs; ' +
            '"platforms", "languages" and "countries" map to the other verified summary tables and take no filters.',
        inputSchema: z.object({
            scope: z
                .enum(['apps', 'platforms', 'languages', 'countries'])
                .optional()
                .describe('Which summary table to read (default "apps")'),
            platformID: optionalNumberParam().describe('Platform filter, only for scope "apps"'),
            directoryIDs: z
                .array(z.string())
                .optional()
                .describe('Directory/category IDs to filter by, only for scope "apps" (sent as directoryID[] as the console does)'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const scope = args.scope ?? 'apps';
        const query = scope === 'apps'
            ? { platformID: args.platformID, 'directoryID[]': args.directoryIDs }
            : undefined;
        const response = await client.get(SUMMARY_PATHS[scope], query);
        const rows = asArray(response.data);
        return jsonText(`Downloads summary (${scope}): ${countLabel(rows.length, 'row')}.`, response.data);
    });
}
/** Accepts unix seconds, a numeric string of seconds, or an ISO 8601 date. */
function toEpochSeconds(value) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
        throw new Error(`Could not read "${value}" as a date. Use an ISO 8601 date (2026-09-01) or unix seconds.`);
    }
    return Math.floor(parsed / 1000);
}
function describeRange(epochSeconds) {
    return `${new Date(epochSeconds * 1000).toISOString().slice(0, 10)} (${epochSeconds})`;
}
