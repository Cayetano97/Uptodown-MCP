import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { UptodownClient } from '../client.js';
import { READ_ONLY, WRITE, WRITE_DESTRUCTIVE_IDEMPOTENT, WRITE_IDEMPOTENT, asArray, asRecord, countLabel, createToolRegistrar, jsonText, mutationText, pickString } from './shared.js';

/** Description, app name and release-notes tools. */
export function registerDescriptionTools(server: McpServer, client: UptodownClient): void {
  const tool = createToolRegistrar(server, client);

  tool(
    'list_descriptions',
    {
      title: 'List app descriptions',
      description:
        'Lists the per-language descriptions of an app (GET /developers/author/{appID}/description/list), ' +
        'including languageID, language and the public description URL. Use languageID with save_description.',
      inputSchema: z.object({
        appID: z.coerce.number().int().positive().describe('Numeric app ID'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const response = await client.get(`/developers/author/${args.appID}/description/list`);
      const descriptions = asArray(response.data);
      return jsonText(
        `Descriptions for app ${args.appID}: ${countLabel(descriptions.length, 'language entry', 'language entries')}.`,
        response.data,
      );
    },
  );

  tool(
    'save_description',
    {
      title: 'Save app description',
      description:
        'Saves the author short and full description for one language ' +
        '(POST /developers/author/description/save). Saved text goes through Uptodown editorial review before it is published.',
      inputSchema: z.object({
        appID: z.coerce.number().int().positive().describe('Numeric app ID'),
        languageID: z.coerce.number().int().positive().describe('Language ID from list_descriptions'),
        authorShortDescription: z.string().describe('Short description shown in listings'),
        authorFullDescription: z.string().describe('Full description shown on the app page'),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async (args) => {
      const response = await client.postJson('/developers/author/description/save', {
        appID: args.appID,
        languageID: args.languageID,
        authorShortDescription: args.authorShortDescription,
        authorFullDescription: args.authorFullDescription,
      });
      return mutationText(
        `Description saved for app ${args.appID}, language ${args.languageID} (pending editorial review).`,
        response,
      );
    },
  );

  tool(
    'generate_ai_description',
    {
      title: 'Generate AI description',
      description:
        'Queues Uptodown AI description generation for an app (POST /developers/description/generate-ai). ' +
        'The generated text appears later in the console; this call only queues the job.',
      inputSchema: z.object({
        appID: z.coerce.number().int().positive().describe('Numeric app ID'),
      }),
      annotations: WRITE,
    },
    async (args) => {
      const response = await client.postJson('/developers/description/generate-ai', { appID: args.appID });
      return mutationText(`AI description queued for app ${args.appID}.`, response);
    },
  );

  tool(
    'set_app_name_all_languages',
    {
      title: 'Set app name in all languages',
      description:
        'Overwrites the app name in every language at once (PUT /developers/app/saveNameAllLanguages). ' +
        'Destructive: existing per-language names are replaced by this single value.',
      inputSchema: z.object({
        appID: z.coerce.number().int().positive().describe('Numeric app ID'),
        name: z.string().min(1).describe('New app name applied to all languages'),
      }),
      annotations: WRITE_DESTRUCTIVE_IDEMPOTENT,
    },
    async (args) => {
      const response = await client.putJson('/developers/app/saveNameAllLanguages', {
        appID: args.appID,
        name: args.name,
      });
      return mutationText(`App ${args.appID} renamed to "${args.name}" in all languages.`, response);
    },
  );

  tool(
    'get_release_notes',
    {
      title: 'Get release notes',
      description:
        'Returns the release notes ("news") of one uploaded version file in one language ' +
        '(GET /developers/author/file/{fileID}/language/{languageID}/news). A 204 answer means no notes are set.',
      inputSchema: z.object({
        fileID: z.coerce.number().int().positive().describe('Version file ID'),
        languageID: z.coerce.number().int().positive().describe('Language ID'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const response = await client.get(`/developers/author/file/${args.fileID}/language/${args.languageID}/news`);
      const news = pickString(asRecord(response.data), 'news');
      if (news === null) {
        return jsonText(`No release notes set for file ${args.fileID} in language ${args.languageID}.`, {
          fileID: args.fileID,
          languageID: args.languageID,
          news: null,
        });
      }
      return jsonText(`Release notes for file ${args.fileID} in language ${args.languageID}.`, {
        fileID: args.fileID,
        languageID: args.languageID,
        news,
      });
    },
  );

  tool(
    'save_release_notes',
    {
      title: 'Save release notes',
      description:
        'Saves the release notes ("news") of one version file in one language ' +
        '(POST /developers/author/file/{fileID}/news/{languageID}).',
      inputSchema: z.object({
        fileID: z.coerce.number().int().positive().describe('Version file ID'),
        languageID: z.coerce.number().int().positive().describe('Language ID'),
        news: z.string().describe('Release notes text for this version and language'),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async (args) => {
      const response = await client.postJson(
        `/developers/author/file/${args.fileID}/news/${args.languageID}`,
        { news: args.news },
      );
      return mutationText(
        `Release notes saved for file ${args.fileID} in language ${args.languageID}.`,
        response,
      );
    },
  );
}
