# Graphics

Visual library for the Vectant ADE vault. Dark-themed SVGs render inline in Obsidian (Reading mode / Live preview).

## System diagrams

Interactive HTML poster: [[System Architecture Poster]] (`Graphics/vectant-architecture.html`)

![[vectant-architecture.svg]]
*Full stack — browser → control plane → media path (Rust) → AI tier → agents, with the cross-cutting trust band. Also available as standalone HTML poster: `Graphics/vectant-architecture.html`.*

![[dependency-map.svg]]
*Who initiates contact with whom + failure coupling and startup order.*

## Flagship: GPU HMR

![[gpu-hmr-pipeline.svg]]
*The 4-stage pipeline with verification doctrine and real measured wall-times.*

![[gpu-hmr-sequence.svg]]
*Sequence view of one hot-reload, human or agent triggered.*

## Trust infrastructure

![[trust-infrastructure.svg]]
*Dojo × CodeSite × Local Support — the three layers of distrust and how they compose.*

## Notes on regeneration

- These SVGs are hand-authored (not auto-generated). Sources of truth for content: [[Architecture Overview]], [[GPU HMR System]], [[Dependency Graph]], [[Dojo Codesite Local Support]].
- To edit: any text editor; SVG is plain XML. Colors follow the dark palette (`#020617` bg, cyan/green/amber/violet/orange semantic fills).
- Overflow-checked programmatically; all text fits.

[[00 Home|🏠 Back to Home]]
