"""Assemble docs/obsidian-src/*.md deep-dive analyses into the Obsidian vault.

Each source file becomes a rich vault note with frontmatter, provenance header,
and standard cross-link footer. Idempotent: re-running overwrites vault notes.
"""
import os
import re
import datetime

REPO = r"C:\Users\polek\Desktop\hermes-abuse\vectant-ade"
SRC = os.path.join(REPO, "docs", "obsidian-src")
VAULT = r"C:\Users\polek\Documents\Obsidian Vault"

# vault-note-name -> (source file, title, system tags, related notes)
NOTES = {
    "Synthi Frontend": ("frontend-synthi.md", "Synthi Frontend",
                        ["frontend", "nextjs"],
                        ["Collab Server", "AI Engine", "Architecture Overview"]),
    "Collab Server": ("collab-server.md", "Collab Server",
                      ["backend", "control-plane"],
                      ["Synthi Frontend", "Rust Systems", "MCP Synthi", "Infra Deployment"]),
    "AI Engine": ("ai-engine.md", "AI Engine",
                  ["python", "llm"],
                  ["GPU HMR System", "Supporting Services", "Collab Server"]),
    "MCP Synthi": ("mcp-synthi.md", "MCP Synthi (Agent Tool Server)",
                   ["typescript", "mcp", "agents"],
                   ["Dojo Codesite Local Support", "Collab Server", "GPU HMR System"]),
    "Rust Systems": ("rust-systems.md", "Rust Systems (WebRTC Worker & Local Support App)",
                     ["rust", "webrtc"],
                     ["Collab Server", "Dojo Codesite Local Support", "Environments and Ports"]),
    "Supporting Services": ("supporting-services.md", "Supporting Services",
                            ["packages", "services"],
                            ["Collab Server", "Synthi Frontend", "MCP Synthi"]),
    "Infra Deployment": ("infra-deployment.md", "Infrastructure & Deployment",
                         ["infra", "docker", "k8s"],
                         ["Environments and Ports", "Repository Map"]),
    "GPU HMR System": ("gpu-hmr.md", "GPU HMR System",
                       ["gpu", "hmr", "flagship"],
                       ["AI Engine", "MCP Synthi", "Rust Systems"]),
    "Dojo Codesite Local Support": ("dojo-codesite.md", "Dojo, Codesite & Local Support",
                                    ["agents", "governance", "trust"],
                                    ["MCP Synthi", "Rust Systems", "Collab Server"]),
    "Docs and Tooling": ("docs-and-tooling.md", "Documentation Index",
                         ["docs", "tooling"],
                         ["Scripts and Tooling", "00 Home|Home"]),
}

FRONTMATTER = """---
tags: {tags}
system: {title}
source-repo: vectant-ade
generated: {date}
---

# {title}

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `{src_rel}` in the repo. All paths below are repo-relative unless noted.

"""


def build():
    made = []
    # Normalize wikilinks that subagents invented but which don't exist as vault notes.
    LINK_FIXES = {
        "[[Documentation Index]]": "[[Docs and Tooling]]",
        "[[AI System Architecture]]": "[[AI Engine]]",
        "[[AI-HMR System Reference]]": "[[AI Engine]]",
        "[[GPU HMR In-Depth Flow]]": "[[GPU HMR System]]",
        "[[gpu-hmr]]": "[[GPU HMR System]]",
    }
    for note_name, (src_file, title, tags, related) in NOTES.items():
        src_path = os.path.join(SRC, src_file)
        if not os.path.exists(src_path):
            print(f"SKIP (missing): {note_name} <- {src_file}")
            continue
        body = open(src_path, encoding="utf-8", errors="replace").read().strip()
        for old, new in LINK_FIXES.items():
            body = body.replace(old, new)
        # demote any h1 in body to bold text so note title stays unique
        body = re.sub(r"^# (.+)$", r"**\1**", body, count=1, flags=re.M)
        footer = "\n\n---\n\n## Related notes\n\n" + " · ".join(
            f"[[{r}]]" for r in related) + f"\n\n[[00 Home|🏠 Back to Home]]\n"
        out = FRONTMATTER.format(
            tags=", ".join(f'"{t}"' for t in tags),
            title=title, date=datetime.date.today().isoformat(),
            src_rel=f"docs/obsidian-src/{src_file}") + body + footer
        dst = os.path.join(VAULT, f"{note_name}.md")
        open(dst, "w", encoding="utf-8").write(out)
        made.append((note_name, len(out)))
    for n, sz in sorted(made):
        print(f"WROTE {n}.md ({sz:,} chars)")
    return len(made)


if __name__ == "__main__":
    n = build()
    print(f"\n{n}/{len(NOTES)} notes assembled")
