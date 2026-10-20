# Nollywood API

Nollywood API is a fully-featured content management platform and API for Nigerian films. Built with Next.js and powered by Contentful headless CMS, this application provides both a comprehensive RESTful API for querying film data and a sleek Admin Dashboard for content management.

## Tech Stack

*   **Framework**: [Next.js 14](https://nextjs.org/) (App Router)
*   **Library**: [React 18](https://react.dev/)
*   **Headless CMS**: [Contentful](https://www.contentful.com/)
*   **Styling**: Vanilla CSS

## Features

*   **Headless API Integration**: Seamless integration with Contentful Delivery and Management APIs.
*   **Admin Dashboard**: A secure, paginated, and intuitive interface to create, update, and delete film records. Includes built-in data validation to prevent duplicate film titles.
*   **Film Search & Pagination**: Full support for searching films by title and paginating through results via the API.
*   **Rich Data Model**: Extensible content model supporting fields like Title, Release Year, Description, Production Company, Directed By, Produced By, Cast, and Poster URLs.

## Getting Started

### Prerequisites

*   Node.js (v18.x or newer recommended)
*   A Contentful Space and environment with the `film` content type configured.

### Installation

1.  Clone the repository and navigate into the project directory:
    ```bash
    cd nollywoodapi
    ```
2.  Install the dependencies:
    ```bash
    npm install
    ```

### Environment Variables

Create a `.env.local` file in the root directory of your project and populate it with your Contentful credentials:

```env
CONTENTFUL_SPACE_ID=your_space_id
CONTENTFUL_ENVIRONMENT=master
CONTENTFUL_ACCESS_TOKEN=your_delivery_api_token
CONTENTFUL_MANAGEMENT_TOKEN=your_management_api_token

# Weekly TMDb sync
TMDB_API_TOKEN=your_tmdb_bearer_token
CRON_SECRET=a_long_random_string
# Optional: comma-separated TMDb company ids for Nigerian production companies
TMDB_NIGERIAN_COMPANY_IDS=
```

### Running the Application Locally

Start the Next.js development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.
Navigate to [http://localhost:3000/admin](http://localhost:3000/admin) to access the admin dashboard.

## Contentful Content Model

Your Contentful space must contain a content type with the ID `film`. It should contain the following fields:

*   `title` (Symbol)
*   `releaseYear` (Integer)
*   `description` (Text)
*   `productionCompany` (Symbol)
*   `directedBy` (Symbol)
*   `producedBy` (Symbol)
*   `cast` (List of Symbols / Text)
*   `posterUrl` (Symbol)

*(Note: There is a local script `update_contentful.mjs` available to programmatically push new fields like `directedBy` and `producedBy` to your environment if they are missing).*

## API Reference

The application exposes Next.js Route Handlers to interact with the film database.

### List / Search Films
*   **Endpoint**: `GET /api/films`
*   **Query Parameters**:
    *   `q` (optional): Search query for titles.
    *   `page` (optional): Page number (defaults to 1).
    *   `limit` (optional): Number of films per page (defaults to 12).
*   **Response**: Returns paginated films, total count, and total pages.

### Create Film
*   **Endpoint**: `POST /api/films`
*   **Body**: JSON object containing film fields.
*   **Response**: 201 Created with the generated film ID and data. (Returns `400 Bad Request` if a film with the exact same title already exists to prevent duplicates).

### Get Film by ID
*   **Endpoint**: `GET /api/films/[id]`
*   **Response**: Details of the specific film.

### Update Film
*   **Endpoint**: `PUT /api/films/[id]`
*   **Body**: JSON object containing updated film fields.
*   **Response**: 200 OK with the updated film data.

### Delete Film
*   **Endpoint**: `DELETE /api/films/[id]`
*   **Response**: 200 OK confirming deletion.

## Automated TMDb Sync

New Nigerian films and TV shows are pulled automatically from [The Movie Database](https://www.themoviedb.org/) every **Sunday at 02:00 UTC** via a Vercel Cron Job. This replaces the previous manual workflow (running a Python script and uploading a CSV).

### How it works

1. **Discovery** - for the current year and the previous year (to catch late additions), the job queries TMDb `discover/movie` and `discover/tv` for titles with origin country `NG`, plus any configured Nigerian production companies.
2. **De-duplication** - titles already stored (matched by `tmdbId`, then by title + year) are skipped, so runs are idempotent.
3. **Enrichment** - for each new title, details + credits are fetched and mapped to the film fields (poster, genres, cast, directors, producers, etc.).
4. **Eligibility** - titles with an empty overview are skipped.
5. **Audit** - each run writes a summary to a `syncLog` content type.

The job is time-budgeted (~240s). If it runs out of time it reports `incomplete: true` and continues from where it left off on the next run.

### One-time setup

Run the migration to add the extended fields to the `film` content type and create the `syncLog` content type:

```bash
npm run contentful:migrate
```

### Preview discovery locally (no writes)

```bash
npm run tmdb:preview -- 2025 --limit 5
```

### Manual trigger

The admin dashboard has a **TMDb Sync** card with a "Run TMDb Sync Now" button and a list of recent runs. You can also hit the cron endpoint directly:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/tmdb-sync
```

### CSV uploads

The CSV bulk upload remains available on the admin dashboard for future or additional data sources (e.g. IMDb, Nollymeter).

## Deployment

This application is ready to be deployed on Vercel. Ensure you add all the Environment Variables listed above to your Vercel project settings before deploying.

```bash
npm run build
npm run start
```
