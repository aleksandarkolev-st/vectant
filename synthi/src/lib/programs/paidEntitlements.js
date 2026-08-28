/**
 * @fileoverview Entitlement store — who is allowed to install/run a paid app.
 * Thin, idempotent prisma wrappers. Rows are keyed by (programId, subjectType,
 * subjectId) — one live entitlement per subject+app — so grant/revoke are
 * upsert/update and safe to call twice (a replayed purchase/refund webhook is a
 * no-op). Grants come from the payments webhook; the `reference` is the
 * idempotency handle carried in the PaymentIntent metadata.
 */

import prisma from '@/lib/prisma';

const whereSubject = ({ programId, subjectType = 'user', subjectId }) => ({
  programId_subjectType_subjectId: { programId, subjectType, subjectId },
});

/** The subject's entitlement row for a program, or null. */
export async function getEntitlement({ programId, subjectType = 'user', subjectId }) {
  return prisma.entitlement.findUnique({ where: whereSubject({ programId, subjectType, subjectId }) });
}

/** The subject's entitlement iff it is currently active, else null. */
export async function getActiveEntitlement(args) {
  const row = await getEntitlement(args);
  return row && row.status === 'active' ? row : null;
}

/** Grant (or re-activate) an entitlement. Idempotent per subject+app. */
export async function grantEntitlement({
  programId, subjectType = 'user', subjectId, source = 'purchase', reference, priceCents = null, currency = null,
}) {
  const data = { status: 'active', source, reference, priceCents, currency, revokedAt: null };
  return prisma.entitlement.upsert({
    where: whereSubject({ programId, subjectType, subjectId }),
    create: { programId, subjectType, subjectId, ...data },
    update: data,
  });
}

/** Revoke an entitlement (refund/chargeback). Idempotent; no-op if absent. */
export async function revokeEntitlement({ programId, subjectType = 'user', subjectId }) {
  return prisma.entitlement.updateMany({
    where: { programId, subjectType, subjectId },
    data: { status: 'revoked', revokedAt: new Date() },
  });
}
