"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  PiArrowRight as ArrowRight,
  PiCodeSimple as Code2,
  PiCommand as Command,
  PiDatabase as Database,
  PiGitBranch as GitBranch,
  PiKey as KeyRound,
  PiLockKey as LockKeyhole,
  PiNetwork as Network,
  PiShieldCheck as ShieldCheck,
  PiSpinner as Loader2,
} from "react-icons/pi";
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

const controlRows = [
  { icon: KeyRound, label: "Provider claims", value: "OAuth verified" },
  { icon: GitBranch, label: "Repository scope", value: "Token isolated" },
  { icon: Database, label: "Workspace state", value: "Membership gated" },
  { icon: Network, label: "Runtime channel", value: "Session bound" },
];

const auditLines = [
  ["identity.resolve", "after provider"],
  ["workspace.acl", "after sign-in"],
  ["runtime.scope", "session gated"],
  ["repo.token", "provider scoped"],
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
          Loading session
        </div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Redirecting
        </div>
      </div>
    );
  }

  return (
    <main className="relative min-h-[100dvh] overflow-x-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--text-primary) 10%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--text-primary) 10%, transparent) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage: "linear-gradient(to bottom, black, transparent 86%)",
        }}
      />

      <section className="relative mx-auto grid min-h-[100dvh] w-full max-w-7xl items-start gap-5 px-4 py-5 sm:px-5 sm:py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_410px] lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="hidden min-h-[520px] flex-col justify-between rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_88%,transparent)] p-5 lg:flex xl:min-h-[560px]"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-4">
            <img src="/vectant-dark-theme.png" alt="Vectant" className="h-8 w-auto" />
            <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_70%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" />
              Sign-in required
            </div>
          </div>

          <div className="max-w-3xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_56%,transparent)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)]">
              <Command className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
              Auth boundary
            </div>
            <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-normal">
              Workspace access starts at the identity boundary.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
              Vectant attaches repository tokens, workspace membership, runtime channels, and file operations only after provider authentication.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-[1fr_0.92fr]">
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_56%,transparent)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                  <Code2 className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                  Access checks
                </div>
                <span className="font-mono text-[11px] text-[var(--text-dim)]">pending</span>
              </div>
              <div className="space-y-1.5 font-mono text-[11px]">
                {auditLines.map(([event, state]) => (
                  <div
                    key={event}
                    className="grid grid-cols-[minmax(0,1fr)_104px] gap-3 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_42%,transparent)] px-3 py-2"
                  >
                    <span className="truncate text-[var(--text-secondary)]">{event}</span>
                    <span className="truncate text-right text-[var(--text-muted)]">{state}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              {controlRows.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_48%,transparent)] p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                      <Icon className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                      {item.label}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">{item.value}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>

        <motion.aside
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.04 }}
          className="mx-auto w-full max-w-[410px] rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_94%,transparent)] p-4 sm:p-5"
        >
          <div className="mb-6 flex items-start justify-between gap-5 border-b border-[var(--border-subtle)] pb-5">
            <div>
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-medium)] bg-[var(--bg-surface)]">
                <ShieldCheck className="h-5 w-5 text-[var(--attention-purple)]" />
              </div>
              <h1 className="text-2xl font-semibold tracking-normal">Authenticate</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                Establish identity before workspace access.
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="th-focus-ring rounded-md border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            >
              Launcher
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
                  className="th-focus-ring flex h-12 w-full items-center justify-between rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    background: method.primary ? "var(--text-primary)" : "var(--bg-app)",
                    color: method.primary ? "var(--bg-app)" : "var(--text-primary)",
                    border: method.primary ? "1px solid var(--text-primary)" : "1px solid var(--border-medium)",
                  }}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="h-4 w-4" />
                    {busy ? "Redirecting" : method.label}
                  </span>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                </motion.button>
              );
            })}
          </div>

          <div className="mt-5 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_54%,transparent)] p-4">
            <div className="flex items-center gap-3 text-sm font-medium">
              <LockKeyhole className="h-4 w-4 text-[var(--text-secondary)]" />
              Granted after sign-in
            </div>
            <div className="mt-3 space-y-2 text-xs text-[var(--text-muted)]">
              {["Workspace ACL", "Repository token access", "Runtime file operations"].map((item) => (
                <div key={item} className="flex items-center justify-between gap-3">
                  <span>{item}</span>
                  <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                </div>
              ))}
            </div>
          </div>

          <p className="mt-5 text-xs leading-5 text-[var(--text-dim)]">
            Authentication is required before Vectant provisions or opens user-scoped workspaces.
          </p>
        </motion.aside>
      </section>
    </main>
  );
}
