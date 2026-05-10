# Lessons

- When a user provides logo or brand image assets, use the supplied files directly instead of recreating the artwork in SVG or code.
- For Next.js Docker builds, `NEXT_PUBLIC_*` values must be injected at build time; runtime compose env does not override values already baked into the client bundle from `.env.production`.
