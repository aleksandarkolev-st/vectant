'use client';

import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FcGoogle } from 'react-icons/fc';
import { FaGithub } from 'react-icons/fa';

export default function LoginPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(null); // 'google' | 'github' | null

  useEffect(() => {
    if (session) router.push('/');
  }, [session, router]);

  const handleGoogleSignIn = () => {
    setSigningIn('google');
    signIn('google');
  };
  const handleGitHubSignIn = () => {
    setSigningIn('github');
    signIn('github');
  };

  if (status === 'loading') {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-app)', color: 'var(--text-secondary)' }}
      >
        <p className="text-sm">Loading session…</p>
      </div>
    );
  }

  if (session) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-app)', color: 'var(--text-secondary)' }}
      >
        <p className="text-sm">Redirecting…</p>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      {/* Ambient gradient halo — atmospheric depth */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          width: 720,
          height: 720,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--brand-stop-3) 12%, transparent) 0%, color-mix(in srgb, var(--brand-stop-1) 5%, transparent) 35%, transparent 70%)',
          filter: 'blur(36px)',
        }}
      />

      <div className="synthi-gradient-border relative" style={{ borderRadius: 16 }}>
        <div
          className="flex flex-col items-center gap-6 px-10 py-10"
          style={{ background: 'var(--bg-editor)', borderRadius: 16, minWidth: 360 }}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Sign in to <span className="vt-brand-text">Vectant</span>
            </h1>
            <p
              className="synthi-body text-sm"
              style={{ color: 'var(--text-muted)' }}
            >
              An editor that heals, thinks, and ships with you.
            </p>
          </div>

          <div className="w-full flex flex-col gap-3">
            {/* GitHub — primary, brand gradient */}
            <button
              onClick={handleGitHubSignIn}
              disabled={signingIn !== null}
              className="synthi-btn w-full flex items-center justify-center gap-2 h-10 text-sm font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ borderRadius: 8 }}
            >
              <FaGithub className="h-4 w-4" />
              {signingIn === 'github' ? 'Redirecting…' : 'Continue with GitHub'}
            </button>

            {/* Google — secondary, calm surface */}
            <button
              onClick={handleGoogleSignIn}
              disabled={signingIn !== null}
              className="w-full flex items-center justify-center gap-2 h-10 text-sm font-medium cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                borderRadius: 8,
              }}
            >
              <FcGoogle className="h-4 w-4" />
              {signingIn === 'google' ? 'Redirecting…' : 'Continue with Google'}
            </button>
          </div>

          <p
            className="text-[11px] text-center"
            style={{ color: 'var(--text-dim)' }}
          >
            By continuing, you agree to use Vectant for development tasks
            within the bounds of its license.
          </p>
        </div>
      </div>
    </div>
  );
}
