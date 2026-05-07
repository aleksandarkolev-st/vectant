'use client';

import { SessionProvider } from 'next-auth/react';
import SessionTokenHydrator from '@/components/SessionTokenHydrator';


export default function NextAuthSessionProvider({ children, session }) {
  return (
    <SessionProvider session={session}>
      <SessionTokenHydrator />
      {children}
    </SessionProvider>
  );
}