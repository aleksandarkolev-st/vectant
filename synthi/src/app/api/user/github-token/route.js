import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';

async function requireUserEmail() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return { error: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  return { email };
}

export async function GET() {
  const { error, email } = await requireUserEmail();
  if (error) return error;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { githubTokenCipher: true, githubLogin: true },
  });
  return NextResponse.json({
    hasToken: !!user?.githubTokenCipher,
    login: user?.githubLogin || null,
  });
}

export async function POST(req) {
  const { error, email } = await requireUserEmail();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  // Validate against GitHub before persisting
  let ghUser;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Synthi-IDE',
      },
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: res.status === 401 ? 'invalid_token' : 'github_error', message: detail?.message || `GitHub returned ${res.status}` },
        { status: 400 },
      );
    }
    ghUser = await res.json();
  } catch (e) {
    return NextResponse.json({ error: 'network_error', message: e.message }, { status: 502 });
  }

  const cipher = encryptToken(token);
  await prisma.user.upsert({
    where: { email },
    update: { githubTokenCipher: cipher, githubLogin: ghUser.login },
    create: { email, githubTokenCipher: cipher, githubLogin: ghUser.login },
  });

  return NextResponse.json({ login: ghUser.login, name: ghUser.name || null });
}

export async function DELETE() {
  const { error, email } = await requireUserEmail();
  if (error) return error;

  await prisma.user.updateMany({
    where: { email },
    data: { githubTokenCipher: null, githubLogin: null },
  });
  return NextResponse.json({ ok: true });
}
