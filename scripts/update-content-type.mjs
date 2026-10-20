// One-off migration: adds the extended TMDb fields to the `film` content type
// and creates the `syncLog` content type used to record weekly sync runs.
//
// Idempotent: existing fields/types are left untouched.
//
// Usage:
//   node --env-file=.env.local scripts/update-content-type.mjs
//
// Requires CONTENTFUL_SPACE_ID, CONTENTFUL_ENVIRONMENT, CONTENTFUL_MANAGEMENT_TOKEN.

import * as contentfulManagementNs from 'contentful-management';

// contentful-management v11 is CommonJS: under bare Node the ESM interop puts
// createClient on the default export, not the namespace. Handle both shapes.
const contentfulManagement = contentfulManagementNs.createClient
  ? contentfulManagementNs
  : contentfulManagementNs.default;

const SPACE_ID = process.env.CONTENTFUL_SPACE_ID;
const ENVIRONMENT_ID = process.env.CONTENTFUL_ENVIRONMENT || 'master';
const TOKEN = process.env.CONTENTFUL_MANAGEMENT_TOKEN;

if (!SPACE_ID || !TOKEN) {
  console.error('Missing CONTENTFUL_SPACE_ID or CONTENTFUL_MANAGEMENT_TOKEN.');
  process.exit(1);
}

// [id, name, type, required?, extra]
const filmFieldsToEnsure = [
  ['tmdbId', 'TMDb ID', 'Integer', false],
  ['tmdbMediaType', 'TMDb Media Type', 'Symbol', false],
  ['source', 'Source', 'Symbol', false],
  ['genres', 'Genres', 'Symbol', false],
  ['runtime', 'Runtime (mins)', 'Integer', false],
  ['originalLanguage', 'Original Language', 'Symbol', false],
  ['imdbId', 'IMDb ID', 'Symbol', false],
  ['tmdbPopularity', 'TMDb Popularity', 'Number', false],
  ['tmdbVoteAverage', 'TMDb Vote Average', 'Number', false],
];

const syncLogFields = [
  ['source', 'Source', 'Symbol', true],
  ['runAt', 'Run At', 'Date', true],
  ['status', 'Status', 'Symbol', true],
  ['addedCount', 'Added Count', 'Integer', false],
  ['skippedCount', 'Skipped Count', 'Integer', false],
  ['skippedEmptyOverview', 'Skipped (Empty Overview)', 'Integer', false],
  ['errorCount', 'Error Count', 'Integer', false],
  ['durationMs', 'Duration (ms)', 'Integer', false],
  ['yearsProcessed', 'Years Processed', 'Symbol', false],
  ['trigger', 'Trigger', 'Symbol', false],
  ['notes', 'Notes', 'Text', false],
];

const client = contentfulManagement.createClient({ accessToken: TOKEN });

async function main() {
  const space = await client.getSpace(SPACE_ID);
  const environment = await space.getEnvironment(ENVIRONMENT_ID);

  // 1. Extend the `film` content type.
  let film = await environment.getContentType('film');
  const existingFilmFieldIds = new Set(film.fields.map((f) => f.id));

  for (const [id, name, type] of filmFieldsToEnsure) {
    if (existingFilmFieldIds.has(id)) {
      console.log(`film.${id} already exists, skipping`);
      continue;
    }
    film.fields.push({ id, name, type, localized: false, required: false, validations: [], disabled: false, omitted: false });
    console.log(`film.${id} added`);
  }
  film = await film.update();
  await film.publish();
  console.log('film content type updated and published');

  // 2. Create the `syncLog` content type.
  let syncLog;
  try {
    syncLog = await environment.getContentType('syncLog');
    console.log('syncLog content type already exists');
  } catch {
    syncLog = await environment.createContentTypeWithId('syncLog', {
      name: 'Sync Log',
      displayField: 'runAt',
      fields: syncLogFields.map(([id, name, type, required]) => ({
        id,
        name,
        type,
        localized: false,
        required: Boolean(required),
        validations: [],
        disabled: false,
        omitted: false,
      })),
    });
    syncLog = await syncLog.publish();
    console.log('syncLog content type created and published');
  }

  console.log('\nDone. You may need to wait for the Contentful CDN to refresh.');
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
