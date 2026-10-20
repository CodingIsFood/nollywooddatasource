import * as contentful from 'contentful';
import * as contentfulManagementNs from 'contentful-management';

// contentful-management v11 is CommonJS. Next's bundler hoists createClient to
// the namespace, but bare Node (scripts, tests) puts it on the default export.
// Resolve both shapes so app code and local scripts share one module.
const contentfulManagement = contentfulManagementNs.createClient
  ? contentfulManagementNs
  : contentfulManagementNs.default;

// Delivery client (read-only, for the frontend / search)
export const deliveryClient = contentful.createClient({
  space: process.env.CONTENTFUL_SPACE_ID,
  accessToken: process.env.CONTENTFUL_ACCESS_TOKEN,
});

// Management client (read/write, for the admin dashboard)
export const managementClient = contentfulManagement.createClient({
  accessToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN,
});

export const SPACE_ID = process.env.CONTENTFUL_SPACE_ID;
export const ENVIRONMENT_ID = process.env.CONTENTFUL_ENVIRONMENT || 'master';

// Builds the Contentful fields payload from a normalised film object.
// Keeps the original core fields intact while persisting the extended TMDb
// metadata (tmdbId, source, genres, etc.) when present. This keeps a single
// source of truth for the film field mapping used by create and update.
function buildFilmFields(filmData) {
  const cast = Array.isArray(filmData.cast)
    ? filmData.cast
    : filmData.cast
      ? String(filmData.cast).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  const fields = {
    title: { 'en-US': filmData.title || '' },
    releaseYear: { 'en-US': parseInt(filmData.releaseYear, 10) || null },
    description: { 'en-US': filmData.description || '' },
    productionCompany: { 'en-US': filmData.productionCompany || '' },
    directedBy: { 'en-US': filmData.directedBy || '' },
    producedBy: { 'en-US': filmData.producedBy || '' },
    cast: { 'en-US': cast },
    posterUrl: { 'en-US': filmData.posterUrl || '' },
  };

  // Extended metadata (only included when provided, so legacy CSV uploads
  // that lack these values remain compatible).
  if (filmData.tmdbId !== undefined && filmData.tmdbId !== null) {
    fields.tmdbId = { 'en-US': parseInt(filmData.tmdbId, 10) || null };
  }
  if (filmData.tmdbMediaType !== undefined) {
    fields.tmdbMediaType = { 'en-US': filmData.tmdbMediaType || '' };
  }
  if (filmData.source !== undefined) {
    fields.source = { 'en-US': filmData.source || '' };
  }
  if (filmData.genres !== undefined) {
    fields.genres = { 'en-US': filmData.genres || '' };
  }
  if (filmData.runtime !== undefined) {
    fields.runtime = { 'en-US': filmData.runtime ? parseInt(filmData.runtime, 10) : null };
  }
  if (filmData.originalLanguage !== undefined) {
    fields.originalLanguage = { 'en-US': filmData.originalLanguage || '' };
  }
  if (filmData.imdbId !== undefined) {
    fields.imdbId = { 'en-US': filmData.imdbId || '' };
  }
  if (filmData.tmdbPopularity !== undefined) {
    fields.tmdbPopularity = { 'en-US': typeof filmData.tmdbPopularity === 'number' ? filmData.tmdbPopularity : null };
  }
  if (filmData.tmdbVoteAverage !== undefined) {
    fields.tmdbVoteAverage = { 'en-US': typeof filmData.tmdbVoteAverage === 'number' ? filmData.tmdbVoteAverage : null };
  }

  return fields;
}

// Utility to search films
export async function searchFilms(query = '', page = 1, limit = 12) {
  const skip = (page - 1) * limit;
  const params = {
    content_type: 'film',
    order: '-sys.createdAt',
    skip: skip,
    limit: limit
  };
  
  if (query) {
    params.query = query;
  }
  
  const entries = await deliveryClient.getEntries(params);
  
  return {
    films: entries.items.map((item) => ({
      id: item.sys.id,
      ...item.fields
    })),
    total: entries.total,
    page: page,
    totalPages: Math.ceil(entries.total / limit)
  };
}

// Utility to create a film
export async function createFilm(filmData) {
  const space = await managementClient.getSpace(SPACE_ID);
  const environment = await space.getEnvironment(ENVIRONMENT_ID);

  const entry = await environment.createEntry('film', {
    fields: buildFilmFields(filmData)
  });

  await entry.publish();
  return { id: entry.sys.id, ...filmData };
}

// Utility to update a film
export async function updateFilm(id, filmData) {
  const space = await managementClient.getSpace(SPACE_ID);
  const environment = await space.getEnvironment(ENVIRONMENT_ID);
  
  const entry = await environment.getEntry(id);
  const fields = buildFilmFields(filmData);
  entry.fields = { ...entry.fields, ...fields };

  const updatedEntry = await entry.update();
  await updatedEntry.publish();
  
  return { id: updatedEntry.sys.id, ...filmData };
}

// Utility to delete a film
export async function deleteFilm(id) {
  const space = await managementClient.getSpace(SPACE_ID);
  const environment = await space.getEnvironment(ENVIRONMENT_ID);
  
  const entry = await environment.getEntry(id);
  if (entry.isPublished()) {
    await entry.unpublish();
  }
  await entry.delete();
}



// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

// Returns the management environment (read/write). Reads during a sync must use
// this (not the delivery CDN) so freshly-published entries are visible.
export async function getEnvironment() {
  const space = await managementClient.getSpace(SPACE_ID);
  return space.getEnvironment(ENVIRONMENT_ID);
}

// Builds the de-duplication key used to match incoming titles against existing
// films: `<normalised title>__<year>`.
//
// Normalisation is deliberately CONSERVATIVE and lossless - it can only make two
// strings that represent the same film collide; it never merges distinct films:
//   - lower-case and collapse internal whitespace
//   - strip a trailing "(YYYY)" disambiguation suffix
//     (the bulk CSV importer appends these on year clashes, e.g. "Freedom Way (2025)")
// It does NOT strip punctuation, articles, or do fuzzy/edit-distance matching,
// because TMDb is one of several data sources and distinct films may share a title.
export function buildTitleKey(title, year) {
  let t = String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
  t = t.replace(/\s*\((\d{4})\)\s*$/, '');
  return `${t}__${year ?? ''}`;
}

// Reads every film entry and returns:
//   - tmdbIds:   Set<number> of TMDb ids already ingested
//   - titleKeys: Set<string> of "title__year" keys for fuzzy fallback matching
// Paginates the management API and excludes archived entries.
export async function getExistingFilmIndex() {
  const environment = await getEnvironment();
  const tmdbIds = new Set();
  const titleKeys = new Set();

  const pageSize = 1000;
  let skip = 0;
  let total = Infinity;

  while (skip < total) {
    const response = await environment.getEntries({
      content_type: 'film',
      skip,
      limit: pageSize,
      'sys.archivedAt[exists]': false,
    });

    total = response.total;
    for (const entry of response.items) {
      const fields = entry.fields || {};

      const tmdbId = fields.tmdbId && fields.tmdbId['en-US'];
      if (tmdbId) tmdbIds.add(Number(tmdbId));

      const title = fields.title && fields.title['en-US'];
      const year = fields.releaseYear && fields.releaseYear['en-US'];
      if (title) {
        titleKeys.add(buildTitleKey(title, year));
      }
    }

    if (response.items.length === 0) break;
    skip += pageSize;
  }

  return { tmdbIds, titleKeys };
}

// Writes a summary of a sync run to the `syncLog` content type. Best-effort:
// failures are swallowed so a logging problem never fails the sync itself.
export async function createSyncLog(log) {
  try {
    const environment = await getEnvironment();
    const entry = await environment.createEntry('syncLog', {
      fields: {
        source: { 'en-US': log.source || 'tmdb' },
        runAt: { 'en-US': log.runAt || new Date().toISOString() },
        status: { 'en-US': log.status || 'success' },
        addedCount: { 'en-US': log.addedCount || 0 },
        skippedCount: { 'en-US': log.skippedCount || 0 },
        skippedEmptyOverview: { 'en-US': log.skippedEmptyOverview || 0 },
        errorCount: { 'en-US': log.errorCount || 0 },
        durationMs: { 'en-US': log.durationMs || 0 },
        yearsProcessed: { 'en-US': log.yearsProcessed || '' },
        trigger: { 'en-US': log.trigger || 'cron' },
        notes: { 'en-US': log.notes || '' },
      },
    });
    await entry.publish();
    return entry.sys.id;
  } catch (error) {
    console.error('Failed to write sync log:', error.message);
    return null;
  }
}

// Returns the most recent sync logs, newest first.
export async function getRecentSyncLogs(limit = 5) {
  try {
    const environment = await getEnvironment();
    const response = await environment.getEntries({
      content_type: 'syncLog',
      order: '-fields.runAt',
      limit,
    });
    return response.items.map((entry) => {
      const f = entry.fields || {};
      const val = (key) => (f[key] && f[key]['en-US'] !== undefined ? f[key]['en-US'] : null);
      return {
        id: entry.sys.id,
        source: val('source'),
        runAt: val('runAt'),
        status: val('status'),
        addedCount: val('addedCount'),
        skippedCount: val('skippedCount'),
        skippedEmptyOverview: val('skippedEmptyOverview'),
        errorCount: val('errorCount'),
        durationMs: val('durationMs'),
        yearsProcessed: val('yearsProcessed'),
        trigger: val('trigger'),
        notes: val('notes'),
      };
    });
  } catch (error) {
    console.error('Failed to read sync logs:', error.message);
    return [];
  }
}
