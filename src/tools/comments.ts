import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { UptodownApiError, type UptodownClient } from '../client.js';
import { READ_ONLY, WRITE, asArray, asRecord, countLabel, createToolRegistrar, jsonText, mutationText } from './shared.js';

/** Author-facing comment tools. */
export function registerCommentTools(server: McpServer, client: UptodownClient): void {
  const tool = createToolRegistrar(server, client);

  tool(
    'list_app_comments',
    {
      title: 'List app comments',
      description:
        'Lists user comments of an app, paginated by offset (GET /developers/comments/{appID}?offset=N). ' +
        'The API answers 404 when the app has no comments; that is reported as an empty list, not an error.',
      inputSchema: z.object({
        appID: z.coerce.number().int().positive().describe('Numeric app ID'),
        offset: z.coerce.number().int().min(0).optional().describe('Pagination offset, starting at 0 (default)'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const offset = args.offset ?? 0;
      let data: unknown;
      try {
        const response = await client.get(`/developers/comments/${args.appID}`, { offset });
        data = response.data;
      } catch (error) {
        if (error instanceof UptodownApiError && error.status === 404) {
          return jsonText(`No comments for app ${args.appID} at offset ${offset}.`, {
            appID: args.appID,
            offset,
            comments: [],
          });
        }
        throw error;
      }

      const comments = asArray(asRecord(data)?.['comments'] ?? data);
      return jsonText(
        `Comments for app ${args.appID} (offset ${offset}): ${countLabel(comments.length, 'comment')}.`,
        data ?? { comments: [] },
      );
    },
  );

  tool(
    'reply_to_comment',
    {
      title: 'Reply to comment',
      description:
        'Posts an author reply to a user comment (POST /developers/comment/{commentID}/answer, multipart replyText). ' +
        'Use the comment IDs returned by list_app_comments. The reply is public: it is published on the app page ' +
        'under your author name as soon as this call succeeds, and it cannot be edited or deleted afterwards.',
      inputSchema: z.object({
        commentID: z.coerce.number().int().positive().describe('Comment ID to answer'),
        replyText: z.string().min(1).describe('Reply text to publish as the author'),
      }),
      annotations: WRITE,
    },
    async (args) => {
      const response = await client.postForm(`/developers/comment/${args.commentID}/answer`, {
        replyText: args.replyText,
      });
      return mutationText(`Reply sent to comment ${args.commentID}.`, response);
    },
  );
}
