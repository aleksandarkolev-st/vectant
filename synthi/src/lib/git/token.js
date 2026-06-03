import prisma from '@/lib/prisma';
import { encryptToken, decryptToken } from '@/lib/tokenCrypto';
import { gitFetch } from './safeFetch.js';
import { oauthEndpoints, oauthClient } from './providerConfig.js';

const SKEW_MS = 60_000;

/** Return a usable access token for a connection, refreshing an expired OAuth token first. */
export async function withFreshToken(conn) {
  if (!conn.secret) {
    await prisma.gitProvider.update({ where: { id: conn.id }, data: { needsRelink: true } });
    throw Object.assign(new Error('missing access token'), { code: 'needs_relink' });
  }
  if (conn.authType === 'pat') return decryptToken(conn.secret.cipher);

  const expired = conn.accessTokenExpiresAt && new Date(conn.accessTokenExpiresAt).getTime() - SKEW_MS <= Date.now();
  if (!expired) return decryptToken(conn.secret.cipher);

  if (!conn.refreshSecret) {
    await prisma.gitProvider.update({ where: { id: conn.id }, data: { needsRelink: true } });
    throw Object.assign(new Error('missing refresh token'), { code: 'needs_relink' });
  }
  const { token: tokenUrl } = oauthEndpoints(conn.providerType, conn.baseUrl);
  const refreshToken = decryptToken(conn.refreshSecret.cipher);
  const { id: clientId, secret: clientSecret } = oauthClient(conn.providerType);
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, client_secret: clientSecret,
  });
  const res = await gitFetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) {
    await prisma.gitProvider.update({ where: { id: conn.id }, data: { needsRelink: true } });
    throw Object.assign(new Error('token refresh failed'), { code: 'needs_relink' });
  }
  const j = await res.json();
  await prisma.encryptedSecret.update({ where: { id: conn.secretId }, data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  if (j.refresh_token) await prisma.encryptedSecret.update({ where: { id: conn.refreshSecretId }, data: { cipher: encryptToken(j.refresh_token) } });
  await prisma.gitProvider.update({ where: { id: conn.id }, data: { accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null, needsRelink: false } });
  return j.access_token;
}
