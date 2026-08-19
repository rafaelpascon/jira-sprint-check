# Jira Sprint Check

Static dashboard for DH sprint status (Production Support, Atlas, Full Throttle Coders, Runtime Terror, Shield), pulling live from Jira via a Cloudflare Worker proxy.

## Structure

- `index.html` — the dashboard. Self-contained, no build step. Deploy as-is to GitHub Pages (or any static host).
- `worker/` — the Cloudflare Worker that proxies Jira requests, adds auth server-side, and restricts CORS. See comments in `worker/worker.js` for what it whitelists.

## How it works

`index.html` has no hardcoded sprint data — on load (and on clicking "Refresh data") it calls the Worker, which forwards a fixed set of Jira REST endpoints with Basic Auth added server-side. The Jira API token never touches the browser or this repo.

## Deploying the Worker

```bash
cd worker
wrangler login
wrangler secret put JIRA_EMAIL
wrangler secret put JIRA_API_TOKEN
wrangler deploy
```

Then set `JIRA_PROXY_URL` in `index.html` to the deployed Worker URL.

## Deploying the dashboard

Enable GitHub Pages on this repo (Settings → Pages → Deploy from branch → `main` / root). The Worker's CORS defaults to allowing `*.github.io` and `localhost`.
