# Ward — web

The human front door to Ward: an editorial landing page that explains the product and a **vet console**
that streams a due-diligence run as it settles on Base. **Live:** https://ward-web-production.up.railway.app

- **Stack:** Next.js 15 (App Router, RSC) · Tailwind v4 (`@theme` tokens) · Fraunces + IBM Plex Mono
  (`next/font`) · a Node SSE route handler that spawns the orchestrator and relays its state trace.
- **Design:** warm editorial zine — cream paper, poster-scale serif, a single highlighter accent,
  flat 1px surfaces.

```bash
npm install
npm run dev      # http://localhost:4477
npm run build    # production build
```

## How the console works

`app/vet-console.tsx` (client) opens an `EventSource` to `app/api/vet/route.ts`, which spawns the
orchestrator (`orchestrator/ … npm run ward`) with the requested token and relays each `→ STATE`
transition, tx hash, and the final §9 verdict as SSE events — so the browser watches Ward negotiate,
pay, firewall, and settle a **real** order live.

> **One WS per key.** The console runs Ward *as a requester* (it needs Ward's WebSocket), so it can't
> run at the same instant as the online `ward-provider`. For an always-on public deploy, point people at
> the live [CROO Store listing](https://agent.croo.network/agents/4a7abd59-40d5-4c99-9ca3-ede49afae6e3)
> to hire Ward directly.
