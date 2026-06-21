"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, CheckCircle2, Code2, Loader2, ShieldCheck } from "lucide-react";
import { FcGoogle } from "react-icons/fc";
import { FaGithub } from "react-icons/fa";

const authMethods = [
  {
    id: "github",
    label: "Continue with GitHub",
    icon: FaGithub,
    primary: true,
  },
  {
    id: "google",
    label: "Continue with Google",
    icon: FcGoogle,
    primary: false,
  },
];

export default function LoginPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(null);

  useEffect(() => {
    if (session) router.push("/");
  }, [session, router]);

  const handleSignIn = (provider) => {
    setSigningIn(provider);
    signIn(provider, { callbackUrl: "/" });
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading session...
        </div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Redirecting...
        </div>
      </div>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(120deg, color-mix(in srgb, var(--bg-app) 74%, var(--brand-stop-4)) 0%, var(--bg-app) 48%, color-mix(in srgb, var(--bg-app) 84%, var(--brand-stop-1)) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--text-primary) 12%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--text-primary) 12%, transparent) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "linear-gradient(90deg, transparent, black 18%, black 82%, transparent)",
        }}
      />

      <section className="relative mx-auto grid min-h-screen w-full max-w-7xl items-center gap-8 px-5 py-8 md:px-8 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="hidden min-h-[640px] flex-col justify-between rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_68%,transparent)] p-8 shadow-2xl lg:flex">
          <div>
            <img src="/vectant-dark-theme.png" alt="Vectant" className="h-9 w-auto" />
            <div className="mt-16 max-w-2xl">
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28 }}
                className="text-6xl font-semibold leading-[0.96] tracking-normal"
              >
                Secure access to your agentic development workspace.
              </motion.h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-[var(--text-secondary)]">
                Vectant keeps repository imports, AI-created workspaces, and runtime sessions tied to your identity.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              ["Auth", "OAuth session"],
              ["Repos", "Scoped clone"],
              ["Runtime", "Per-user worktree"],
            ].map(([label, detail]) => (
              <div key={label} className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_48%,transparent)] p-3">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{label}</div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">{detail}</div>
              </div>
            ))}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
          className="mx-auto w-full max-w-[440px] rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_90%,transparent)] p-6 shadow-2xl"
        >
          <div className="mb-8 flex items-start justify-between gap-5">
            <div>
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-medium)] bg-[var(--bg-surface)]">
                <ShieldCheck className="h-5 w-5 text-[var(--attention-purple)]" />
              </div>
              <h1 className="text-3xl font-semibold tracking-normal">Sign in to Vectant</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
                Use a connected provider to open workspaces and sync repository access.
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            >
              Start
            </button>
          </div>

          <div className="space-y-3">
            {authMethods.map((method) => {
              const Icon = method.icon;
              const busy = signingIn === method.id;
              return (
                <motion.button
                  key={method.id}
                  type="button"
                  onClick={() => handleSignIn(method.id)}
                  disabled={signingIn !== null}
                  whileHover={{ y: signingIn ? 0 : -1 }}
                  whileTap={{ scale: signingIn ? 1 : 0.99 }}
                  className="flex h-12 w-full items-center justify-between rounded-lg px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    background: method.primary ? "var(--text-primary)" : "var(--bg-app)",
                    color: method.primary ? "var(--bg-app)" : "var(--text-primary)",
                    border: method.primary ? "1px solid var(--text-primary)" : "1px solid var(--border-medium)",
                  }}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="h-4 w-4" />
                    {busy ? "Redirecting..." : method.label}
                  </span>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                </motion.button>
              );
            })}
          </div>

          <div className="mt-6 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_48%,transparent)] p-4">
            <div className="flex items-center gap-3 text-sm font-medium">
              <Code2 className="h-4 w-4 text-[var(--text-secondary)]" />
              Development session
            </div>
            <div className="mt-3 space-y-2 text-xs text-[var(--text-muted)]">
              {["Workspace membership", "Repository credentials", "Runtime file operations"].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-[var(--accent-success)]" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          <p className="mt-5 text-xs leading-5 text-[var(--text-dim)]">
            Continuing creates an authenticated Vectant session for development workspaces.
          </p>
        </motion.div>
      </section>
    </main>
  );
}
