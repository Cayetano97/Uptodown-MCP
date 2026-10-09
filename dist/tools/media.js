import * as z from 'zod/v4';
import { assertUploadPathAllowed } from '../file-root.js';
import { READ_ONLY, WRITE, WRITE_DESTRUCTIVE, WRITE_DESTRUCTIVE_IDEMPOTENT, WRITE_IDEMPOTENT, asArray, countLabel, createToolRegistrar, jsonText, mutationText } from './shared.js';
const MULTIFILE_FIELD = 'multifile[]';
/** Screenshot, icon and video tools. */
export function registerMediaTools(server, client) {
    const tool = createToolRegistrar(server, client);
    tool('list_screenshots', {
        title: 'List screenshots',
        description: 'Lists the screenshots of an app for one language (GET /developers/screenshot/getappscreenshots). ' +
            'A 204 answer means that language has no screenshots yet.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            languageID: z.coerce.number().int().positive().describe('Language ID (see list_languages)'),
        }),
        annotations: READ_ONLY,
    }, async (args) => {
        const response = await client.get('/developers/screenshot/getappscreenshots', {
            appID: args.appID,
            languageID: args.languageID,
        });
        if (response.empty || response.data === null || response.data === undefined) {
            return jsonText(`No screenshots for app ${args.appID} in language ${args.languageID}.`, {
                appID: args.appID,
                languageID: args.languageID,
                screenshots: [],
            });
        }
        const screenshots = asArray(response.data);
        return jsonText(`Screenshots for app ${args.appID} in language ${args.languageID}: ${countLabel(screenshots.length, 'item')}.`, response.data);
    });
    tool('upload_screenshots', {
        title: 'Upload screenshots',
        description: 'Uploads one or more screenshots for an app in one language ' +
            '(POST /developers/screenshot/addappscreenshots, multipart with a repeated multifile[] field, as the console sends it).',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            languageID: z.coerce.number().int().positive().describe('Language ID (see list_languages)'),
            filePaths: z
                .array(z.string().min(1))
                .min(1)
                .describe('Absolute paths of the image files to upload, in the order they should be stored'),
        }),
        annotations: WRITE,
    }, async (args) => {
        for (const path of args.filePaths) {
            assertUploadPathAllowed(path);
        }
        const response = await client.postForm('/developers/screenshot/addappscreenshots', {
            languageID: args.languageID,
            appID: args.appID,
        }, args.filePaths.map((path) => ({ field: MULTIFILE_FIELD, path })));
        return mutationText(`Uploaded ${countLabel(args.filePaths.length, 'screenshot')} for app ${args.appID} in language ${args.languageID}.`, response);
    });
    tool('upload_feature_graphic', {
        title: 'Upload feature graphic',
        description: 'Uploads the feature graphic of an app for one language ' +
            '(POST /developers/author/screenshot/feature, multipart with a repeated multifile[] field).',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            languageID: z.coerce.number().int().positive().describe('Language ID (see list_languages)'),
            filePaths: z.array(z.string().min(1)).min(1).describe('Absolute paths of the feature graphic files'),
        }),
        annotations: WRITE,
    }, async (args) => {
        for (const path of args.filePaths) {
            assertUploadPathAllowed(path);
        }
        const response = await client.postForm('/developers/author/screenshot/feature', {
            languageID: args.languageID,
            appID: args.appID,
        }, args.filePaths.map((path) => ({ field: MULTIFILE_FIELD, path })));
        return mutationText(`Uploaded ${countLabel(args.filePaths.length, 'feature graphic')} for app ${args.appID} in language ${args.languageID}.`, response);
    });
    tool('remove_screenshot', {
        title: 'Remove screenshot',
        description: 'Removes one screenshot from an app (POST /developers/screenshot/removeappscreenshot). ' +
            'Use the screenshotID values returned by list_screenshots. Destructive.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            screenshotID: z.coerce.number().int().positive().describe('Screenshot ID to remove'),
        }),
        annotations: WRITE_DESTRUCTIVE,
    }, async (args) => {
        const response = await client.postForm('/developers/screenshot/removeappscreenshot', {
            screenshotID: args.screenshotID,
            appID: args.appID,
        });
        return mutationText(`Screenshot ${args.screenshotID} removed from app ${args.appID}.`, response);
    });
    tool('sort_screenshots', {
        title: 'Sort screenshots',
        description: 'Sets the display order of an app\'s screenshots ' +
            '(POST /developers/screenshot/sortappscreenshots, multipart with a repeated screenshotsID[] field). ' +
            'The order of the IDs you pass is the order users will see.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            screenshotsID: z
                .array(z.coerce.number().int().positive())
                .min(1)
                .describe('Screenshot IDs in the desired display order'),
        }),
        annotations: WRITE_IDEMPOTENT,
    }, async (args) => {
        const response = await client.postForm('/developers/screenshot/sortappscreenshots', {
            appID: args.appID,
            'screenshotsID[]': args.screenshotsID,
        });
        return mutationText(`Display order updated for ${countLabel(args.screenshotsID.length, 'screenshot')} of app ${args.appID}.`, response);
    });
    tool('update_app_icon', {
        title: 'Update app icon',
        description: 'Replaces the icon of an app (POST /developers/app/updateicon, multipart appID + icon). ' +
            'The new image becomes the public icon on the app page immediately and the previous icon is not kept.',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            filePath: z.string().min(1).describe('Absolute path of the new icon image'),
        }),
        annotations: WRITE_DESTRUCTIVE_IDEMPOTENT,
    }, async (args) => {
        assertUploadPathAllowed(args.filePath);
        const response = await client.postForm('/developers/app/updateicon', { appID: args.appID }, [{ field: 'icon', path: args.filePath }]);
        return mutationText(`Icon updated for app ${args.appID}.`, response);
    });
    tool('save_video', {
        title: 'Save video',
        description: 'Attaches a YouTube video to an app for one language ' +
            '(POST /developers/author/app/{appID}/video/save, multipart appID + youtubeURL + languageID).',
        inputSchema: z.object({
            appID: z.coerce.number().int().positive().describe('Numeric app ID'),
            youtubeURL: z.url().describe('YouTube URL of the video'),
            languageID: z.coerce.number().int().positive().describe('Language ID (see list_languages)'),
        }),
        annotations: WRITE,
    }, async (args) => {
        const response = await client.postForm(`/developers/author/app/${args.appID}/video/save`, {
            appID: args.appID,
            youtubeURL: args.youtubeURL,
            languageID: args.languageID,
        });
        return mutationText(`Video saved for app ${args.appID} in language ${args.languageID}.`, response);
    });
}
