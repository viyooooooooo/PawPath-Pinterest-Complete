# PawPath

PawPath connects animals in need with accountable rescuers, fosters, adopters, community feeders and veterinary professionals.

## What is included

- Explore page, categorized listings, verified-people directory and urgent SOS board.
- Standard signup plus a separate verification application covering identity, residence, veterinary reference, home-check consent and welfare commitments.
- Ten seeded verified demo profiles with twelve animal listings.
- Logged-in users see other people’s listings before their own.
- PostgreSQL in production with SQLite fallback for local development.

## Local setup

```bash
npm install
npm start
```

Open `http://localhost:3000`. Demo password for seeded profiles: `PawPath123`.

Reviewer demo account: `aarohi@pawpath.local` / `PawPath123`. Its dashboard links to the verification review queue.

## Permanent database on Render

1. In Render, create **New → PostgreSQL** in the same region as the web service.
2. Copy the database’s **Internal Database URL**.
3. Open the PawPath web service → **Environment**.
4. Add `DATABASE_URL` with that URL.
5. Add `SESSION_SECRET` with a long random value.
6. Save and deploy the latest commit. The start command automatically creates tables and adds the demo profiles without duplicating them.

Once `DATABASE_URL` exists, users, listings, applications and verification requests survive web-service restarts and deployments.

## Verification safety note

The prototype stores references or secure links, not uploaded documents. A real production review operation should use encrypted private document storage, access controls, deletion schedules and a manual reviewer dashboard. Never collect a full Aadhaar number in a general text field.
