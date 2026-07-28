import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Braces,
  FolderGit2,
  Layers3,
  PanelsTopLeft,
  Radar,
  Search,
  Sparkles,
} from "lucide-react";

const quickActions = [
  {
    href: "/",
    label: "Open launcher",
    detail: "Repos, folders, uploads",
    Icon: PanelsTopLeft,
  },
  {
    href: "/",
    label: "Import repository",
    detail: "Git-aware workspace",
    Icon: FolderGit2,
  },
  {
    href: "/",
    label: "Start with brief",
    detail: "Agent-scaffolded runtime",
    Icon: Sparkles,
  },
];

const lanes = [
  { label: "Editor", value: "Docked", Icon: Braces },
  { label: "Agents", value: "Routed", Icon: Radar },
  { label: "Search", value: "Indexed", Icon: Search },
  { label: "Panels", value: "Grouped", Icon: Layers3 },
];

export default function WorkspacePage() {
  return (
    <main className="vt-app-surface min-h-[100dvh] overflow-hidden px-5 py-5 text-[var(--text-primary)] sm:px-8">
      <div className="mx-auto flex min-h-[calc(100dvh-40px)] w-full max-w-[1280px] flex-col">
        <header className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="th-focus-ring group inline-flex items-center gap-3 rounded-[10px] px-2 py-2 transition-transform duration-200 active:translate-y-px"
            aria-label="Go to Vectant ADE start"
          >
            <span className="relative grid size-9 place-items-center overflow-hidden rounded-[9px] border border-[var(--border-subtle)] bg-[var(--bg-panel)]">
              <Image
                src="/vectant/the_V.png"
                alt=""
                width={24}
                height={25}
                className="relative z-10"
                priority
              />
              <span className="absolute inset-0 opacity-65 blur-md" style={{ background: "var(--brand-gradient)" }} />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-sm font-semibold tracking-tight">Vectant ADE</span>
              <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Workspace
              </span>
            </span>
          </Link>

          <Link
            href="/"
            className="th-focus-ring th-btn-ghost inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-3 text-xs font-semibold"
          >
            Start
            <ArrowRight className="size-3.5" strokeWidth={1.8} />
          </Link>
        </header>

        <section className="grid flex-1 items-stretch gap-6 py-8 lg:grid-cols-[0.92fr_1.08fr] lg:py-10">
          <div className="max-w-[690px]">
            <div className="mb-7 inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--text-secondary)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_6%,transparent)]">
              <span className="size-1.5 rounded-full" style={{ background: "var(--attention-purple)" }} />
              Agent workspace ready
            </div>

            <h1 className="max-w-[14ch] text-[42px] font-semibold leading-[0.96] text-balance sm:text-[56px] lg:text-[64px]">
              Workspace command deck
            </h1>

            <p className="mt-7 max-w-[58ch] text-[15px] leading-7 text-[var(--text-secondary)]">
              Open a recent workspace, import a repository, or start an agent-guided project from the same control surface.
            </p>

            <div className="mt-9 grid gap-2">
              {quickActions.map(({ href, label, detail, Icon }) => (
                <Link
                  key={label}
                  href={href}
                  className="th-focus-ring group grid min-h-[72px] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_76%,transparent)] px-3 py-2 transition-colors duration-200"
                >
                  <span className="grid size-9 place-items-center rounded-[8px] bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] text-[var(--text-secondary)]">
                    <Icon className="size-4" strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="mt-1 block text-xs text-[var(--text-muted)]">{detail}</span>
                  </span>
                  <ArrowRight className="size-4 text-[var(--text-muted)] transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={1.7} />
                </Link>
              ))}
            </div>
          </div>

          <div className="vt-command-surface relative min-h-[520px] overflow-hidden p-3">
            <div className="absolute inset-x-16 top-0 h-px opacity-70" style={{ background: "var(--brand-gradient-horizontal)" }} />
            <div className="vt-inset-panel flex h-full min-h-[494px] flex-col overflow-hidden">
              <div className="vt-toolbar flex items-center justify-between px-3">
                <div className="flex items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-[7px] bg-[color-mix(in_srgb,var(--attention-purple)_13%,transparent)] text-[var(--attention-purple)]">
                    <Radar className="size-3.5" strokeWidth={1.8} />
                  </span>
                  <span className="text-xs font-semibold">Orchestration</span>
                </div>
                <span className="vt-mono rounded-[6px] border border-[var(--border-subtle)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
                  live
                </span>
              </div>

              <div className="grid flex-1 grid-rows-[auto_1fr_auto] gap-3 p-3">
                <div className="grid gap-1.5">
                  {lanes.map(({ label, value, Icon }) => (
                    <div key={label} className="grid min-h-12 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_74%,transparent)] px-2.5 py-2">
                      <span className="text-[var(--text-muted)]">
                        <Icon className="size-3.5" strokeWidth={1.7} />
                      </span>
                      <span className="text-sm font-semibold">{label}</span>
                      <span className="vt-mono text-[10px] text-[var(--text-muted)]">{value}</span>
                    </div>
                  ))}
                </div>

                <div className="relative overflow-hidden rounded-[9px] border border-[var(--border-subtle)] bg-[var(--bg-app)]">
                  <div className="absolute left-8 right-8 top-12 h-px bg-[var(--border-medium)]" />
                  <div className="absolute bottom-10 left-14 right-12 h-px bg-[var(--border-subtle)]" />
                  <div className="absolute left-14 top-12 h-[calc(100%-88px)] w-px bg-[var(--border-subtle)]" />
                  <div className="absolute right-12 top-12 h-[calc(100%-88px)] w-px bg-[var(--border-subtle)]" />
                  <div className="absolute left-[46px] top-[38px] size-7 rounded-[8px] border border-[color-mix(in_srgb,var(--attention-purple)_42%,transparent)] bg-[color-mix(in_srgb,var(--attention-purple)_15%,transparent)] shadow-[0_0_24px_-12px_var(--attention-purple)]" />
                  <div className="absolute right-[34px] top-[38px] size-7 rounded-[8px] border border-[var(--border-medium)] bg-[var(--bg-panel)]" />
                  <div className="absolute bottom-[28px] left-[46px] size-7 rounded-[8px] border border-[var(--border-medium)] bg-[var(--bg-panel)]" />
                  <div className="absolute bottom-[28px] right-[34px] size-7 rounded-[8px] border border-[color-mix(in_srgb,var(--brand-stop-4)_38%,transparent)] bg-[color-mix(in_srgb,var(--brand-stop-4)_12%,transparent)]" />
                  <div className="absolute left-1/2 top-1/2 grid size-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[18px] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_86%,transparent)] shadow-[0_24px_80px_-52px_rgba(0,0,0,0.95)]">
                    <Image src="/vectant/the_V.png" alt="" width={58} height={60} />
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <div className="vt-skeleton h-9 rounded-[8px]" />
                  <Link
                    href="/"
                    className="th-focus-ring th-btn-primary inline-flex h-9 items-center gap-2 px-3 text-xs font-semibold"
                  >
                    Open
                    <ArrowRight className="size-3.5" strokeWidth={1.8} />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
