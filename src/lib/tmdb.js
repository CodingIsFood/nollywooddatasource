// Thin, dependency-free client for The Movie Database (TMDb) API v3.
// This is the JavaScript port of the former "tmdb scraper.py" used to build
// CSVs manually. It exposes both the discovery logic (which titles are
// eligible Nigerian content) and the enrichment logic (details + credits),
// plus a normaliser that maps a TMDb record into our internal film shape.
//
// No Contentful or Next.js imports here on purpose: this module must remain
// reusable from cron routes, admin routes, and one-off local scripts.

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Nigerian language codes used for the "with_original_language" filter.
// Hausa (ha), Igbo (ig), Yoruba (yo), Nigerian Pidgin (pcm), plus the
// colonial-legacy official language (en) which most Nigerian productions use.
export const NIGERIAN_LANGUAGE_CODES = ['ha', 'ig', 'yo', 'pcm', 'en'];

// Well-known Nigerian production companies on TMDb. These are used with the
// `with_companies` discovery filter so we catch Nigerian films that TMDb has
// tagged with a non-NG origin country but a Nigerian production company.
// Configure via TMDB_NIGERIAN_COMPANY_IDS (comma-separated TMDb company ids).
// Unknown/invalid ids are simply ignored by TMDb.
export const NIGERIAN_COMPANY_IDS = (process.env.TMDB_NIGERIAN_COMPANY_IDS || '')
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

function getAuthHeaders() {
  const token = process.env.TMDB_API_TOKEN;
  if (!token) {
    throw new Error('TMDB_API_TOKEN is not configured');
  }
  return {
    accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function tmdbFetch(path, params = {}) {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url.toString(), {
      headers: getAuthHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TMDb request failed (${res.status}) for ${path}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// Builds the base discovery params shared by movie and tv queries for a given
// year. Eligibility = Nigerian origin country OR Nigerian production company,
// with Nigerian original language preferred.
function buildDiscoverParams(mediaType, year, page) {
  const params = {
    page,
    language: 'en-US',
    include_adult: 'false',
    sort_by: 'popularity.desc',
  };

  if (mediaType === 'movie') {
    params.primary_release_year = year;
    params.include_video = 'false';
  } else {
    params.first_air_date_year = year;
  }

  return params;
}

// Fetches every result page for a single (mediaType, year) and returns the
// flattened list of raw discovery results. `pageDelayMs` spaces out the page
// requests to stay within TMDb's rate limits.
export async function discoverTitlesByYear(mediaType, year, { pageDelayMs = 150, maxPages = 50 } = {}) {
  const results = [];

  // TMDb's discover endpoint does not OR two filters together, so we union
  // an origin-country pass with a company pass, then de-duplicate.

  // Pass 1: origin country = NG.
  const originResults = await paginateDiscover(mediaType, year, { with_origin_country: 'NG' }, pageDelayMs, maxPages);
  results.push(...originResults);

  // Pass 2: Nigerian production companies (catches content TMDb labels with a
  // non-NG origin but a Nigerian company). Skipped when no company ids exist.
  if (NIGERIAN_COMPANY_IDS.length > 0) {
    const companyResults = await paginateDiscover(
      mediaType,
      year,
      { with_companies: NIGERIAN_COMPANY_IDS.join('|') },
      pageDelayMs,
      maxPages
    );
    results.push(...companyResults);
  }

  // De-duplicate by id, preserving discovery (popularity) order.
  const seen = new Set();
  const deduped = [];
  for (const item of results) {
    if (!item || item.id === undefined || item.id === null) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}

async function paginateDiscover(mediaType, year, extraParams, pageDelayMs, maxPages) {
  const collected = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = { ...buildDiscoverParams(mediaType, year, page), ...extraParams };
    const data = await tmdbFetch(`/discover/${mediaType}`, params);
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) break;

    collected.push(...results);
    totalPages = data.total_pages || 1;
    page += 1;

    if (page <= totalPages) await sleep(pageDelayMs);
  } while (page <= totalPages && page <= maxPages);

  return collected;
}

// ---------------------------------------------------------------------------
// Enrichment (details + credits)
// ---------------------------------------------------------------------------

// Fetches details + credits for a single title. Returns a normalised film
// object ready to be persisted, or null when the title is ineligible (e.g.
// an empty overview, per the "skip empty overviews" policy).
export async function fetchAndNormalise(mediaType, id, { delayMs = 150 } = {}) {
  if (mediaType === 'movie') {
    const details = await tmdbFetch(`/movie/${id}`, { language: 'en-US' });
    await sleep(delayMs);
    const credits = await tmdbFetch(`/movie/${id}/credits`, { language: 'en-US' });
    await sleep(delayMs);
    return normaliseMovie(details, credits);
  }

  const details = await tmdbFetch(`/tv/${id}`, { language: 'en-US' });
  await sleep(delayMs);
  const credits = await tmdbFetch(`/tv/${id}/aggregate_credits`, { language: 'en-US' });
  await sleep(delayMs);
  return normaliseTv(details, credits);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean))];
}

function namesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => entry && entry.name).filter(Boolean);
}

function normaliseMovie(details, credits) {
  const overview = (details.overview || '').trim();
  if (!overview) return null; // skip empty overviews

  const cast = namesOf((credits.cast || []).slice(0, 10));
  const crew = credits.crew || [];
  const directors = uniqueNonEmpty(crew.filter((c) => c.job === 'Director').map((c) => c.name));
  const producers = uniqueNonEmpty(crew.filter((c) => c.job === 'Producer').map((c) => c.name));
  const companies = namesOf(details.production_companies);
  const genres = namesOf(details.genres);

  return {
    title: details.title,
    type: 'Movie',
    releaseYear: details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : null,
    description: overview,
    productionCompany: companies.join(', '),
    directedBy: directors.join(', '),
    producedBy: producers.join(', '),
    cast,
    posterUrl: details.poster_path ? `${TMDB_IMAGE_BASE}${details.poster_path}` : '',
    // Extended metadata (new fields):
    tmdbId: details.id,
    tmdbMediaType: 'movie',
    source: 'tmdb',
    genres: genres.join(', '),
    runtime: details.runtime || null,
    originalLanguage: details.original_language || '',
    imdbId: details.imdb_id || '',
    tmdbPopularity: details.popularity || null,
    tmdbVoteAverage: details.vote_average || null,
  };
}

function normaliseTv(details, credits) {
  const overview = (details.overview || '').trim();
  if (!overview) return null; // skip empty overviews

  const cast = namesOf((credits.cast || []).slice(0, 10));
  const creators = uniqueNonEmpty(namesOf(details.created_by));

  // Executive producers: aggregate_credits staffs crew as { name, jobs: [{job}] }.
  const execProducers = uniqueNonEmpty(
    (credits.crew || []).flatMap((member) =>
      (member.jobs || [])
        .filter((job) => (job.job || '').includes('Executive Producer'))
        .map(() => member.name)
    )
  );

  const networks = namesOf(details.networks);
  const productionCompanies = namesOf(details.production_companies);
  const companies = uniqueNonEmpty([...networks, ...productionCompanies]);
  const genres = namesOf(details.genres);

  const year = details.first_air_date
    ? parseInt(details.first_air_date.slice(0, 4), 10)
    : null;

  return {
    title: details.name,
    type: 'TV Show',
    releaseYear: year,
    description: overview,
    productionCompany: companies.join(', '),
    directedBy: creators.join(', '),
    producedBy: execProducers.join(', '),
    cast,
    posterUrl: details.poster_path ? `${TMDB_IMAGE_BASE}${details.poster_path}` : '',
    // Extended metadata (new fields):
    tmdbId: details.id,
    tmdbMediaType: 'tv',
    source: 'tmdb',
    genres: genres.join(', '),
    runtime: null, // TV runtime is not meaningful; left null for TV entries
    originalLanguage: details.original_language || '',
    imdbId: '',
    tmdbPopularity: details.popularity || null,
    tmdbVoteAverage: details.vote_average || null,
  };
}
