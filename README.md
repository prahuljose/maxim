# Maxim

A WebRTC call analyser. Lives at **https://maxim.us.kg**. It's a static Astro site, and everything runs
in the browser: no backend, no AI, no tracking.

Drop in a Chrome `webrtc-internals` dump (e.g. from the Sprinklr Voice Debug Console) to get a verdict
for the reported problem, the key numbers, findings with evidence, a who-was-audible timeline and synced
charts. Network path, device, SDP, raw stats, the event log and an optional manual AI second opinion
sit in folded sections below.

- `src/lib/webrtc/`: pure, tested analysis, `parse` → `metrics` → `diagnose` → `verdict`, plus `ai`
  (the manual prompt/reply round trip; the reply is shown as interpretation only) and `synthetic`
  (test and demo dumps, which use RFC 5737 documentation IPs).
- `src/scripts/analyser/`: the page UI (SVG charts, views, controller). `src/pages/index.astro` is the page.
- Links: `/?demo` loads a synthetic demo call; `?issue=choppy` preselects the reported problem.
- **Real dumps go in `samples/` (gitignored, never deployed)** because they contain IPs and call IDs.
  Tests use them when present, and in dev `/?sample=<name>` loads `samples/<name>.json`.

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm test         # analyser tests (Vitest)
npm run build    # static output in dist/
```

## Deploy (Vercel)

Pushes to `main` deploy automatically once the GitHub repo is imported into Vercel
(**Add New → Project → Import**, with the defaults from `vercel.json`).

`vercel.json` also sets a strict Content-Security-Policy. `connect-src 'none'` means the browser
blocks every network request the page could make, so "nothing is uploaded" is enforced rather than
just promised. Keep it that way: the analyser must never need the network.

**Custom domain:** in Vercel, open **Project → Settings → Domains** and add `maxim.us.kg`, then
create the DNS record Vercel shows in the DigitalPlat (us.kg) dashboard.
