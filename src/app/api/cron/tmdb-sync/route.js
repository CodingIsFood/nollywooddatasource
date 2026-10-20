// Weekly TMDb sync, invoked by Vercel Cron (see vercel.json).
// Protected by CRON_SECRET: Vercel sends `Authorization: Bearer <CRON_SECRET>`
// automatically when that env var exists.
import { NextResponse } from 'next/server';
import { runTmdbSync } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runTmdbSync({ trigger: 'cron' });
    return NextResponse.json(summary, { status: 200 });
  } catch (error) {
    console.error('Cron TMDb sync failed:', error);
    return NextResponse.json({ error: 'Sync failed', details: error.message }, { status: 500 });
  }
}
