#!/usr/bin/env node
/**
 * Manual smoke test against the real Uptodown API.
 *
 * Run it with a real session or real password credentials:
 *
 *   npm run build
 *   npm run login              # once, in a browser (Google, GitHub or email)
 *   npm run smoke
 *
 * Password auth works too: set UPTODOWN_EMAIL and UPTODOWN_PASSWORD instead of a session.
 * It prints the active auth mode, the author profile, the author's apps and the descriptions
 * of the first app. Nothing is written to disk and credentials/cookies are never printed.
 */
import { UptodownApiError, UptodownClient } from './client.js';

const client = new UptodownClient();

async function main(): Promise<void> {
  const configurationError = client.configurationError;
  if (configurationError !== null) {
    process.stderr.write(`smoke: ${configurationError}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n=== auth mode ===\n${client.authSummary}\n`);

  const profile = await client.get('/developers/author/logged-data');
  print('whoami', profile.data);

  const totalResponse = await client.get('/developers/author/total-apps');
  print('total apps', totalResponse.data);

  let apps: readonly unknown[] = [];
  try {
    const appsResponse = await client.get('/developers/author/organization/apps', { page: 1 });
    apps = Array.isArray(appsResponse.data) ? appsResponse.data : [];
  } catch (error) {
    // A 404 means the profile has no apps on that page; that is a valid smoke result, not a failure.
    if (!(error instanceof UptodownApiError && error.status === 404)) throw error;
  }
  print('my apps', { count: apps.length, apps });

  const firstAppID = firstAppIDOf(apps);
  if (firstAppID === null) {
    process.stderr.write('smoke: no app with a readable ID was returned; skipping list_descriptions\n');
    return;
  }

  const descriptions = await client.get(`/developers/author/${firstAppID}/description/list`);
  print(`list_descriptions (appID ${firstAppID})`, descriptions.data);
}

/** The app list payload has used both `appID` and `appId` spellings; accept either. */
function firstAppIDOf(apps: readonly unknown[]): number | null {
  for (const app of apps) {
    if (typeof app !== 'object' || app === null) continue;
    const record = app as Record<string, unknown>;
    for (const key of ['appID', 'appId', 'id']) {
      const value = record[key];
      const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function print(label: string, value: unknown): void {
  process.stdout.write(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`smoke: failed: ${client.redact(message)}\n`);
  process.exitCode = 1;
});
