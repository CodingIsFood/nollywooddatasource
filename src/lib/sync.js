// Orchestrates a TMDb -> Contentful sync run.
//
// Design goals:
//  - Idempotent: only NEW tmdbIds are ingested (no duplicate growth).
//  - Bounded: processes until a time budget is reached, then reports partial
//    progress so the caller (cron/manual) can invoke it again to continue.
//  - Resilient: a single failed title never aborts the whole run.
//  - Auditable: every run writes a summary to the `syncLog` content type.

import { discoverTitlesByYear, fetchAndNormalise } from './tmdb';
import { createFilm, getExistingFilmIndex, createSyncLog, buildTitleKey } from './contentful';

// Scope is pinned to the current year (2026) per product intent: historical and
// 2025 coverage already exist, and TMDb is only one of several data sources.
// Set yearsBack=1 in options to also re-check the previous year for late additions.
const DEFAULT_YEARS_BACK = 0;

function targetYears(yearsBack = DEFAULT_YEARS_BACK) {
  const current = new Date().getUTCFullYear();
  const years = [];
  for (let i = 0; i <= yearsBack; i += 1) years.push(current - i);
  return years;
}

// Runs a single sync. Returns a structured summary object.
//
// options:
//   - yearsBack:   how many prior years to include (default 1)
//   - budgetMs:    soft time budget for this invocation (default 240_000)
//   - trigger:     'cron' | 'manual' (for the sync log)
//   - delayMs:     TMDb per-request pacing (default 150)
export async function runTmdbSync({
  yearsBack = DEFAULT_YEARS_BACK,
  budgetMs = 240000,
  trigger = 'cron',
  delayMs = 150,
  dryRun = false,
} = {}) {
  const startedAt = Date.now();
  const years = targetYears(yearsBack);

  const summary = {
    source: 'tmdb',
    trigger,
    runAt: new Date().toISOString(),
    status: 'success',
    yearsProcessed: years.join(', '),
    discovered: 0,
    addedCount: 0,
    skippedCount: 0,
    skippedEmptyOverview: 0,
    errorCount: 0,
    errors: [],
    incomplete: false,
    dryRun,
    wouldCreate: [],
    durationMs: 0,
  };

  const withinBudget = () => Date.now() - startedAt < budgetMs;

  let index;
  try {
    index = await getExistingFilmIndex();
  } catch (error) {
    summary.status = 'error';
    summary.notes = `Failed to read existing film index: ${error.message}`;
    summary.durationMs = Date.now() - startedAt;
    await createSyncLog(summary);
    return summary;
  }

  const { tmdbIds, titleKeys } = index;

  outer: for (const year of years) {
    for (const mediaType of ['movie', 'tv']) {
      if (!withinBudget()) {
        summary.incomplete = true;
        break outer;
      }

      let discovered;
      try {
        discovered = await discoverTitlesByYear(mediaType, year, { pageDelayMs: delayMs });
      } catch (error) {
        summary.errorCount += 1;
        summary.errors.push(`discover ${mediaType} ${year}: ${error.message}`);
        continue;
      }

      summary.discovered += discovered.length;

      for (const item of discovered) {
        if (!withinBudget()) {
          summary.incomplete = true;
          break outer;
        }

        // Already ingested by TMDb id -> skip fast, no detail calls.
        if (tmdbIds.has(Number(item.id))) {
          summary.skippedCount += 1;
          continue;
        }

        let film;
        try {
          film = await fetchAndNormalise(mediaType, item.id, { delayMs });
        } catch (error) {
          summary.errorCount += 1;
          summary.errors.push(`${mediaType} ${item.id}: ${error.message}`);
          continue;
        }

        // Ineligible (empty overview, per policy) -> skip, do not record id.
        if (!film) {
          summary.skippedEmptyOverview += 1;
          continue;
        }

        // Fuzzy fallback: same title + year already exists from another source.
        // Skip to avoid duplicates, but do not mark the tmdbId as ingested, so
        // a future enrichment pass can still associate it deliberately.
        const titleKey = buildTitleKey(film.title, film.releaseYear);
        if (titleKeys.has(titleKey)) {
          summary.skippedCount += 1;
          continue;
        }

        // Dry run: record what would be created, write nothing.
        if (dryRun) {
          summary.wouldCreate.push({
            title: film.title,
            releaseYear: film.releaseYear,
            mediaType,
            tmdbId: film.tmdbId,
            genres: film.genres,
            hasPoster: Boolean(film.posterUrl),
            overview: (film.description || '').slice(0, 160),
          });
          summary.addedCount += 1;
          titleKeys.add(titleKey);
          continue;
        }

        try {
          await createFilm(film);
          summary.addedCount += 1;
          tmdbIds.add(Number(film.tmdbId));
          titleKeys.add(titleKey);
        } catch (error) {
          summary.errorCount += 1;
          summary.errors.push(`create ${mediaType} ${item.id}: ${error.message}`);
        }
      }
    }
  }

  summary.durationMs = Date.now() - startedAt;
  if (summary.errorCount > 0) {
    summary.status = summary.addedCount > 0 ? 'partial' : 'error';
  }
  if (summary.incomplete) {
    summary.status = 'partial';
    summary.notes = 'Time budget reached; run again to continue.';
  }
  if (summary.errors.length > 0) {
    summary.notes = `${summary.notes ? summary.notes + ' ' : ''}${summary.errors.slice(0, 10).join(' | ')}`;
  }

  if (!dryRun) {
    await createSyncLog(summary);
  }
  return summary;
}
