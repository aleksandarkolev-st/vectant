import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import prisma from '@/lib/prisma';
import { ensureDefaultPrograms } from '@/lib/programs/defaultPrograms';

export const runtime = 'nodejs';

// POST /api/programs/seed-defaults
// Idempotently seed the official @vectant/* default catalog. Inert unless the
// operator sets ENABLE_PROGRAM_SEED=1 (so it can't be triggered casually), and
// still requires an authenticated session.
export async function POST() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (process.env.ENABLE_PROGRAM_SEED !== '1') {
    return NextResponse.json({ error: 'seed_disabled' }, { status: 404 });
  }

  const seeded = await ensureDefaultPrograms(prisma);
  return NextResponse.json({ seeded, count: seeded.length });
}
