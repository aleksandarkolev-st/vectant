import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__synthiPrisma ||
  new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__synthiPrisma = prisma;
}

export default prisma;
