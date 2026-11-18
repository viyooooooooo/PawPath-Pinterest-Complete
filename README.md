# PawPath

PawPath connects animals in need with accountable rescuers, fosters, adopters, community feeders and veterinary professionals.

## What is included

- Explore page, categorized listings, India-wide searchable network and urgent SOS board.
- Standard signup plus a separate verification application covering identity, residence, veterinary reference, home-check consent and welfare commitments.
- Ten seeded verified demo profiles with twelve animal listings.
- 3,679 imported public network records: 26 rescue/volunteer contacts, 34 veterinary records and 3,619 AWBI-recognised organisations.
- Interactive India map with clustered Listings and Network layers, SOS highlighting, search, category filters and browser-based “near me”.
- Scroll-led Explore story with an animated PawPath puppy and map camera transitions.
- Twelve distinct demo-animal photographs—no repeated listing image.
- Logged-in users see other people’s listings before their own.
- PostgreSQL in production with SQLite fallback for local development.

## Local setup

```bash
npm install
npm start
```

Open `http://localhost:3000`. Demo password for seeded profiles: `PawPath123`.

Reviewer demo account: `aarohi@pawpath.local` / `PawPath123`. Its dashboard links to the verification review queue.

The first `npm start` imports the India directory. Later starts skip the import unless the source version changes, so deployments do not create duplicate records. PawPath user accounts, listings, applications and messages remain separate from imported public directory entries.

## Map locations

The map uses Leaflet, OpenStreetMap tiles and marker clustering, so it does not require a Google Maps API key. Seeded Indore listings use locality-level coordinates. Nationwide directory records are placed from the city, district or state supplied by their public source and are labelled as approximate in the interface. PawPath does not claim that an approximate pin is a precise entrance or live rescue location.

The migration adds `latitude`, `longitude` and `location_accuracy` to users, animal listings and public directory entries without deleting existing records. The updated directory source version runs once on the next deploy and safely refreshes the 3,679 imported map points.

## PostgreSQL on Render

1. In Render, create **New → PostgreSQL** in the same region as the web service.
2. Copy the database’s **Internal Database URL**.
3. Open the PawPath web service → **Environment**.
4. Add `DATABASE_URL` with that URL.
5. Add `SESSION_SECRET` with a long random value.
6. Save and deploy the latest commit. The start command automatically creates the tables, adds demo data and imports the India directory without duplicating records.

Once `DATABASE_URL` exists, users, listings, applications and verification requests survive web-service restarts and deployments.

After deployment, open the Render logs. A successful first import includes:

```text
PawPath India directory imported: 3679 records.
```

Later deployments show:

```text
PawPath directory already current: 3679 imported records.
```

To confirm the production import with Render's database shell, run:

```sql
SELECT category, COUNT(*)
FROM directory_entries
GROUP BY category
ORDER BY category;
```

Expected imported counts are `26` volunteers, `34` vets and `3619` organisations. The ten demo PawPath members appear separately in the Network page.

### Important Render free-database limit

The database shown in the supplied screenshot is on Render's Free plan and is scheduled to expire on **18 December 2026**. A free Render PostgreSQL database is not permanent: upgrade it before that date if the PawPath data must remain available. The application import can recreate the public directory, but it cannot recreate real user accounts, messages or listings after the database is deleted.

Do not paste the database password, External Database URL, Internal Database URL or `SESSION_SECRET` into GitHub, source files or screenshots. Keep them only in Render environment variables.

## Directory data and trust labels

- **PawPath verified** means a registered PawPath member passed the PawPath review flow.
- **Source checked / Official source** means the supplied contact was collected from the linked public source. It is not PawPath identity verification.
- **AWBI recognised** means the organisation appears on the official AWBI register.
- AWBI recognition alone does not confirm present-day dog/cat rescue, capacity or emergency availability. These records remain `needs_service_verification` until checked by the PawPath team.

The original input files and the normalized AWBI CSV are stored in `data/imports/`. The automatic importer is `directory-seed.js`.

## Verification safety note

The prototype stores references or secure links, not uploaded documents. A real production review operation should use encrypted private document storage, access controls, deletion schedules and a manual reviewer dashboard. Never collect a full Aadhaar number in a general text field.
