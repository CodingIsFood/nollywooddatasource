// Local, read-only preview of TMDb discovery. Makes NO Contentful writes.
// Use this to sanity-check eligibility/filters and the field mapping before a
// sync run, and to tune TMDB_NIGERIAN_COMPANY_IDS.
//
// Usage:
//   node --env-file=.env.local scripts/tmdb-preview.mjs [year] [--limit N]

import { discoverTitlesByYear, fetchAndNormalise } from '../src/lib/tmdb.js';

const args = process.argv.slice(2);
const yearArg = args.find((a) => /^\d{4}$/.test(a));
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 10;

const years = yearArg
  ? [parseInt(yearArg, 10)]
  : [new Date().getUTCFullYear(), new Date().getUTCFullYear() - 1];

async function main() {
  for (const year of years) {
    for (const mediaType of ['movie', 'tv']) {
      console.log(`\n=== ${mediaType.toUpperCase()} ${year} ===`);
      const results = await discoverTitlesByYear(mediaType, year, { pageDelayMs: 150 });
      console.log(`discovered ${results.length} titles`);

      const sample = results.slice(0, limit);
      for (const item of sample) {
        try {
          const film = await fetchAndNormalise(mediaType, item.id, { delayMs: 150 });
          if (!film) {
            console.log(`  - ${item.title || item.name} [SKIP: no overview]`);
          } else {
            console.log(`  - ${film.title} (${film.releaseYear}) [tmdb ${film.tmdbId}]`);
            console.log(`      directors: ${film.directedBy || '-'}`);
            console.log(`      cast: ${(film.cast || []).slice(0, 3).join(', ') || '-'}`);
            console.log(`      genres: ${film.genres || '-'} | lang: ${film.originalLanguage} | poster: ${film.posterUrl ? 'yes' : 'no'}`);
          }
        } catch (error) {
          console.log(`  - id ${item.id} ERROR: ${error.message}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('Preview failed:', error.message);
  process.exit(1);
});
