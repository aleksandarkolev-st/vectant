"""Assemble area-*.md exhaustive analyses into the Obsidian vault as Area notes.

Run any time; idempotent. Only includes files that are substantially written
(>8KB or >4 sections), so partial skeletons from still-running agents are skipped
until they're refined.
"""
import os
import re
import datetime

REPO = r"C:\Users\polek\Desktop\hermes-abuse\vectant-ade"
SRC = os.path.join(REPO, "docs", "obsidian-src")
VAULT = r"C:\Users\polek\Documents\Obsidian Vault"

# area file -> (note name, tags, related vault notes)
AREA_NOTES = {
    "area-synthi-app.md": ("Area - Synthi App Routes",
        ["frontend", "routes", "api"], ["Synthi Frontend", "Area - Synthi Lib and Data"]),
    "area-synthi-ui.md": ("Area - Synthi UI Components",
        ["frontend", "components"], ["Synthi Frontend"]),
    "area-synthi-lib.md": ("Area - Synthi Lib and Data",
        ["frontend", "lib", "prisma"], ["Synthi Frontend", "Area - Synthi App Routes"]),
    "area-collab-server.md": ("Area - Collab Server Modules",
        ["backend", "modules"], ["Collab Server", "Area - Supporting Services Internals"]),
    "area-ai-engine.md": ("Area - AI Engine Endpoints",
        ["python", "endpoints"], ["AI Engine", "Area - GPU HMR Pipeline Files"]),
    "area-mcp-synthi.md": ("Area - MCP Tool Catalog",
        ["mcp", "tools"], ["MCP Synthi", "Dojo Codesite Local Support"]),
    "area-rust-webrtc.md": ("Area - Rust Worker Modules",
        ["rust", "webrtc"], ["Rust Systems", "GPU HMR System"]),
    "area-local-support.md": ("Area - Local Support Internals",
        ["rust", "trust"], ["Dojo Codesite Local Support", "Rust Systems"]),
    "area-infra-files.md": ("Area - Infra File Reference",
        ["infra"], ["Infra Deployment", "Environments and Ports"]),
    "area-supporting.md": ("Area - Supporting Services Internals",
        ["packages", "gateway"], ["Supporting Services", "Collab Server"]),
    "area-gpu-hmr.md": ("Area - GPU HMR Pipeline Files",
        ["gpu", "hmr"], ["GPU HMR System", "AI Engine", "Area - Rust Worker Modules"]),
}

FRONTMATTER = """---
tags: {tags}
type: exhaustive-area-reference
source-repo: vectant-ade
generated: {date}
---

"""


def main():
    made = []
    for src_file, (title, tags, related) in AREA_NOTES.items():
        p = os.path.join(SRC, src_file)
        if not os.path.exists(p):
            continue
        body = open(p, encoding="utf-8", errors="replace").read().strip()
        # agents sometimes emit [[src/foo.rs]]-style fake wikilinks for file paths;
        # convert those to code spans so vault links stay clean.
        body = re.sub(r"\[\[((?:src|desktop|tests|bin)[^\]|]*?)(?:\|[^\]]*)?\]\]",
                      lambda m: "`" + m.group(1).split("#")[0] + "`", body)
        # other path/doc-name pseudo-links agents emitted; map or neutralize
        FAKE_LINKS = {
            "Cargo.toml": "`Cargo.toml`",
            "VECTANT_LOCAL_SUPPORT_APP_PLAN": "`docs/VECTANT_LOCAL_SUPPORT_APP_PLAN.md`",
            "docs-and-tooling": "[[Docs and Tooling]]",
            "rust-systems": "[[Rust Systems]]",
            "gpu-hmr": "[[GPU HMR System]]",
            "area-ai-engine": "[[Area - AI Engine Endpoints]]",
            "area-mcp-synthi": "[[Area - MCP Tool Catalog]]",
            "area-rust-webrtc": "[[Area - Rust Worker Modules]]",
            "area-collab-server": "[[Area - Collab Server Modules]]",
            "area-synthi-app": "[[Area - Synthi App Routes]]",
            "area-synthi-ui": "[[Area - Synthi UI Components]]",
            "area-synthi-lib": "[[Area - Synthi Lib and Data]]",
            "area-local-support": "[[Area - Local Support Internals]]",
            "area-infra-files": "[[Area - Infra File Reference]]",
            "area-supporting": "[[Area - Supporting Services Internals]]",
            "area-gpu-hmr": "[[Area - GPU HMR Pipeline Files]]",
        }
        for fake, target in FAKE_LINKS.items():
            body = body.replace(f"[[{fake}]]", target)
        for fake in ("scripts/windows-installer-smoke.ps1", "target-windows-validation/"):
            body = body.replace(f"[[{fake}]]", f"`{fake}`")
        sections = len(re.findall(r"^## ", body, flags=re.M))
        if len(body) < 8000 and sections < 4:
            print(f"skip (still skeleton): {src_file} ({len(body):,} ch, {sections} sec)")
            continue
        body = re.sub(r"^# (.+)$", lambda m: f"**{m.group(1)}**", body, count=1, flags=re.M)
        footer = ("\n\n---\n\n## Related\n\n" + " · ".join(f"[[{r}]]" for r in related)
                  + "\n\n[[00 Home|🏠 Back to Home]]\n")
        out = (FRONTMATTER.format(tags=", ".join(f'"{t}"' for t in tags),
                                  date=datetime.date.today().isoformat())
               + f"# {title}\n\n"
               + f"> [!info] Exhaustive reference — every module/route/file in this area, "
                 f"with `path:LNN` citations. Raw source: `docs/obsidian-src/{src_file}`.\n\n"
               + body + footer)
        dst = os.path.join(VAULT, title + ".md")
        open(dst, "w", encoding="utf-8").write(out)
        made.append((title, len(out)))
    for t, sz in sorted(made):
        print(f"assembled {t}.md ({sz:,} ch)")
    print(f"{len(made)} area notes in vault")


if __name__ == "__main__":
    main()
