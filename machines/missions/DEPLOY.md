# Deployment path

The public desk and this mission page are the `web/` app in **this** repository, `Hobie1Kenobi/aether-foundry`. There is no second website repo in this workspace.

Vercel project settings already used by the desk:

- Repository: `https://github.com/Hobie1Kenobi/aether-foundry`
- Root directory: `web`
- Framework: Next.js
- Production host: `https://aether-foundry-desk.vercel.app`

This cloud run does not deploy and does not merge. After review:

1. Confirm `npm test` on the PR, including `src/missions/missions.test.js` and `src/desk/missions-public.test.ts`.
2. Confirm the missions page shows authorized caps, spending disabled, and live spend 0 as separate figures.
3. Deploy from the existing Vercel Git integration, or from a trusted machine with the Vercel project already linked:

```bash
cd web
npm ci
npm run build
npx vercel --prod
```

4. After deploy, these must be read-only and must not show a live spend:

```bash
curl -sS https://aether-foundry-desk.vercel.app/api/missions
curl -sS https://aether-foundry-desk.vercel.app/api/missions/status
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://aether-foundry-desk.vercel.app/api/missions
curl -sS https://aether-foundry-desk.vercel.app/missions
```

`POST` must be 405. `source` stays `snapshot` until a reviewed sanitized feed replaces `machines/missions/public-feed.json`. Do not point the desk at `lab/missions/`. Do not set a spending flag in Vercel env. Activation of signing is not a website env change.

`*.v0.build` hosts are not this deploy.
