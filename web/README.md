# Cobalt — web

Next.js (App Router) port of the standalone `landing/index.html` and `viewer/index.html`
pages: `/` is the marketing page, `/viewer` is the live, read-only Enclave Registry
dashboard (real client-side Keccak-256, ABI codec, and JSON-RPC calls against Monad
testnet — no backend, no API keys).

## Run locally

```bash
npm install && npm run dev
```

Then open `http://localhost:3000`.

## Deploy on Vercel

This repo can be imported directly into Vercel with **Root Directory set to `web/`**.
Vercel auto-detects the Next.js framework preset from `web/package.json` and builds/deploys
with zero additional configuration — no environment variables or secrets are required, since
every dynamic value on `/viewer` is a public, read-only call to the public Monad testnet RPC
endpoint made from the visitor's browser.
