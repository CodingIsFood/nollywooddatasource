// Manual TMDb sync, triggered from the admin dashboard.
// Auth: the admin auth cookie set by /api/auth (middleware also protects /admin,
// but this API route validates the cookie itself since it lives under /api).
import { NextResponse } from 'next/server';
import { runTmdbSync } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function hasAdminCookie(request) {
  const token = request.cookies.get('auth-token');
  return token && token.value === 'authenticated';
}

export async function POST(request) {
  if (!hasAdminCookie(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ?dryRun=1 reports what would be created without writing anything.
    const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';
    const summary = await runTmdbSync({ trigger: 'manual', dryRun });
    return NextResponse.json(summary, { status: 200 });
  } catch (error) {
    console.error('Manual TMDb sync failed:', error);
    return NextResponse.json({ error: 'Sync failed', details: error.message }, { status: 500 });
  }
}
