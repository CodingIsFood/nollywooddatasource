// Returns recent TMDb sync logs for display in the admin dashboard.
import { NextResponse } from 'next/server';
import { getRecentSyncLogs } from '@/lib/contentful';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const logs = await getRecentSyncLogs(5);
    return NextResponse.json({ logs }, { status: 200 });
  } catch (error) {
    console.error('Failed to load sync status:', error);
    return NextResponse.json({ error: 'Failed to load sync status', logs: [] }, { status: 500 });
  }
}
