import prisma from '@/lib/prisma';
import { encryptToken, decryptToken } from '@/lib/tokenCrypto';
import { resolveApprovedJupyterOrigin } from './policy';

function publicServer(row) { const { secret, secretId, ...server } = row; return { ...server, hasToken: Boolean(secret), tokenLast4: secret?.last4 || null }; }
export async function listJupyterServers(workspaceSlug) { return (await prisma.jupyterServer.findMany({ where: { workspaceSlug }, include: { secret: true }, orderBy: { createdAt: 'desc' } })).map(publicServer); }
export async function createJupyterServer({ workspaceSlug, name, origin, token = null, mountPath = '' }) { const approvedOrigin = await resolveApprovedJupyterOrigin(origin); let secretId = null; if (token) { const secret = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(token), last4: token.slice(-4) } }); secretId = secret.id; } return publicServer(await prisma.jupyterServer.create({ data: { workspaceSlug, name: String(name).trim().slice(0, 120), origin: approvedOrigin, mountPath: String(mountPath || '').replace(/^\/+|\/+$/g, ''), secretId }, include: { secret: true } })); }
export async function getJupyterServer(id, workspaceSlug) { return prisma.jupyterServer.findFirst({ where: { id, workspaceSlug }, include: { secret: true } }); }
export async function resolveJupyterServer(id, workspaceSlug) { const row = await getJupyterServer(id, workspaceSlug); if (!row || !row.enabled) return null; return { ...row, token: row.secret ? decryptToken(row.secret.cipher) : null }; }
export async function revokeJupyterServer(id, workspaceSlug) { const row = await getJupyterServer(id, workspaceSlug); if (!row) return false; await prisma.jupyterServer.delete({ where: { id } }); if (row.secretId) await prisma.encryptedSecret.delete({ where: { id: row.secretId } }).catch(() => {}); return true; }
