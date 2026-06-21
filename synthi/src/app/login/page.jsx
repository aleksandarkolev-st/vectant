"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Command,
  GitBranch,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
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

const trustItems = [
  "Workspace membership",
  "Repository credentials",
  "Runtime file operations",
];

const activityRows = [
  { icon: GitBranch, label: "Repo import", value: "Scoped clone" },
  { icon: Sparkles, label: "Agent setup", value: "Ready after sign in" },
  { icon: LockKeyhole, label: "Identity", value: "Provider session" },
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
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading session...
        </div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Redirecting...
        </div>
      </div>
    );
  }

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 17% 18%, color-mix(in srgb, var(--brand-stop-3) 24%, transparent), transparent 31%), radial-gradient(circle at 86% 12%, color-mix(in srgb, var(--brand-stop-4) 18%, transparent), transparent 30%), linear-gradient(135deg, color-mix(in srgb, var(--bg-app) 82%, var(--brand-stop-1)) 0%, var(--bg-app) 44%, color-mix(in srgb, var(--bg-app) 84%, var(--brand-stop-4)) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.17]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--text-primary) 12%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--text-primary) 12%, transparent) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "linear-gradient(90deg, transparent, black 16%, black 84%, transparent)",
        }}
      />

      <section className="relative mx-auto grid min-h-[100dvh] w-full max-w-7xl items-center gap-7 px-5 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_430px]">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          className="hidden min-h-[660px] flex-col justify-between rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_72%,transparent)] p-6 shadow-[0_24px_80px_-48px_color-mix(in_srgb,var(--brand-stop-3)_70%,transparent)] backdrop-blur-xl lg:flex"
        >
          <div className="flex items-center justify-between">
            <img src="/vectant-dark-theme.png" alt="Vectant" className="h-9 w-auto" />
            <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_58%,transparent)] px-3 py-2 text-xs text-[var(--text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-success)]" />
              Auth gateway
            </div>
          </div>

          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_52%,transparent)] px-3 py-2 text-xs font-medium text-[var(--text-muted)]">
              <Command className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
              Agent workspace access
            </div>
            <h1 className="max-w-4xl text-5xl font-semibold leading-[0.98] tracking-normal">
              Sign in to the workspace where agents can actually work.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
              Connect an identity, open a repo, and keep file operations tied to the same Vectant session.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-[1.08fr_0.92fr]">
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_54%,transparent)] p-4">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--brand-stop-1)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--brand-stop-2)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--brand-stop-4)]" />
                </div>
                <span className="font-mono text-[11px] text-[var(--text-dim)]">auth.vectant</span>
              </div>
              <div className="space-y-2 font-mono text-xs">
                {["resolve provider", "hydrate membership", "open recent workspaces"].map((line, index) => (
                  <motion.div
                    key={line}
                    initial={{ opacity: 0.45, x: -4 }}
                    animate={{ opacity: [0.45, 1, 0.68], x: 0 }}
                    transition={{ duration: 1.8, delay: index * 0.22, repeat: Infinity, repeatDelay: 3 }}
                    className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2 text-[var(--text-secondary)]"
                  >
                    <span className="text-[var(--attention-purple)]">$</span>
                    <span>{line}</span>
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="grid gap-3">
              {activityRows.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_48%,transparent)] p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                      <Icon className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                      {item.label}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">{item.value}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>

        <motion.aside
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, delay: 0.04 }}
          className="mx-auto w-full max-w-[430px] rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_92%,transparent)] p-6 shadow-[0_24px_80px_-46px_color-mix(in_srgb,var(--brand-stop-4)_72%,transparent)] backdrop-blur-xl"
        >
          <div className="mb-8 flex items-start justify-between gap-5">
            <div>
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-medium)] bg-[var(--bg-surface)]">
                <ShieldCheck className="h-5 w-5 text-[var(--attention-purple)]" />
              </div>
              <h1 className="text-3xl font-semibold tracking-normal">Sign in to Vectant</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
                Choose a provider to enter your development workspace.
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

          <div className="mt-6 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_52%,transparent)] p-4">
            <div className="flex items-center gap-3 text-sm font-medium">
              <Code2 className="h-4 w-4 text-[var(--text-secondary)]" />
              Session scope
            </div>
            <div className="mt-3 space-y-2 text-xs text-[var(--text-muted)]">
              {trustItems.map((item) => (
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
        </motion.aside>
      </section>
    </main>
  );
}
