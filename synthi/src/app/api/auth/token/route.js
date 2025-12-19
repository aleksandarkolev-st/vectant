import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import jwt from 'jsonwebtoken';

export async function GET(req) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const payload = { user: token.user || token }; // include user data in payload
    const signed = jwt.sign(payload, process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET, { expiresIn: '15m' });
    return NextResponse.json({ token: signed });
  } catch (e) {
    console.error('Failed to create signed token', e?.message || e);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }
}
