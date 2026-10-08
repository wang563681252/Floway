import type { InferResponseType } from 'hono/client';
import { z } from 'zod';

import type { api } from '../../api/client';
import { errorMessage } from '../../lib/error-message';

// Annotated with the gateway's own literal so a bump there fails this
// assignment instead of silently rejecting every backup the deployment writes.
export const BACKUP_FILE_VERSION: InferResponseType<typeof api.api.export.$get, 200>['version'] = 22;

const backupFileSchema = z.object({
  version: z.union([z.literal(20), z.literal(21), z.literal(BACKUP_FILE_VERSION)]),
  exportedAt: z.string(),
  data: z.object({
    users: z.array(z.unknown()),
    apiKeys: z.array(z.unknown()),
    upstreams: z.array(z.unknown()),
    subscriptionPools: z.array(z.unknown()).optional(),
    subscriptionConversations: z.array(z.unknown()).optional(),
    subscriptionPoolIntake: z.array(z.unknown()).optional(),
    proxies: z.array(z.unknown()),
    usage: z.array(z.unknown()),
    searchUsage: z.array(z.unknown()),
    performance: z.array(z.unknown()).optional(),
    performanceIncluded: z.boolean(),
    searchConfig: z.unknown(),
  }).strict().superRefine((data, ctx) => {
    if (data.performanceIncluded !== (data.performance !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'performance must be present exactly when performanceIncluded is true',
        path: ['performance'],
      });
    }
  }),
}).strict().superRefine((payload, ctx) => {
  if (payload.version >= 21 && payload.data.subscriptionPools === undefined) {
    ctx.addIssue({ code: 'custom', message: `version ${payload.version} requires subscriptionPools configuration`, path: ['data', 'subscriptionPools'] });
  }
  if (payload.version === 22 && (payload.data.subscriptionConversations === undefined || payload.data.subscriptionPoolIntake === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'version 22 requires conversation routing and intake metadata', path: ['data', 'subscriptionConversations'] });
  }
});

export type BackupFile = z.infer<typeof backupFileSchema>;
export type BackupFileData = BackupFile['data'];

export type ParsedBackupFile =
  | { ok: true; payload: BackupFile }
  | { ok: false; message: string };

// A rejected file is nearly always an export from another version or product,
// so every issue is reported by path rather than collapsed into one message.
const issueList = (error: z.ZodError): string => error.issues
  .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
  .join('; ');

export const parseBackupFile = (raw: string): ParsedBackupFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  const result = backupFileSchema.safeParse(parsed);
  return result.success
    ? { ok: true, payload: result.data }
    : { ok: false, message: issueList(result.error) };
};
