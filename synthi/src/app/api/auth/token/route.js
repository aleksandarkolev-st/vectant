import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import jwt from 'jsonwebtoken';

export async function GET(req) {
  try {
    const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (!authSecret) {
      return NextResponse.json({ error: 'Auth secret is not configured' }, { status: 500 });
    }
    const token = await getToken({ req, secret: authSecret });
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const subject = token.sub || token.userId || token.email || token.name || 'authenticated-user';
    const signed = jwt.sign(
      { sub: String(subject), typ: 'gateway' },
      authSecret,
      { expiresIn: '15m', audience: 'synthi-gateway' }
    );
    return NextResponse.json({ token: signed });
  } catch (e) {
    console.error('Failed to create signed token', e?.message || e);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }
}
