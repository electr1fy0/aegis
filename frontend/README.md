# Aegis frontend

This app uses TanStack Start, React, Tailwind CSS v4, and shadcn Base UI components. The frontend reads all exercise records from the `/api` backend; it does not contain runtime report or incident fixtures.

## Run locally

Start the backend from the repository root, then run `bun run dev` in this directory. Vite serves on `127.0.0.1` and proxies `/api` to `127.0.0.1:8000`.

Useful checks are `bun run build`, `bun run test`, and `bun run coverage`.

## Preset provenance

The requested preset is `b3PkSQ` with the Start template. The exact `bunx --bun shadcn@latest init --preset b3PkSQ --template start` bootstrap was attempted, but the sandbox could not resolve the package registry hostname. The app was assembled from the available TanStack Start dependencies and the preset’s resolved options: Base UI Nova (`base-nova`), neutral base colors with the orange theme, and Tabler icons. The used Nova component rules are copied from the official shadcn v4 Nova stylesheet and the native select uses the official Base UI registry component pattern.

The preset's Figtree font is self-hosted through the locked `@fontsource-variable/figtree` package. Its font assets are bundled locally; no remote font service is required.
