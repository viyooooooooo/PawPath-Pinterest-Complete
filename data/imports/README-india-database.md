# PawPath — India-wide animal-welfare database

`india_awbi_2026.sql` imports all **3,619** organisations on the Animal Welfare Board of India (AWBI) list dated **31 March 2026**. Each row includes its AWBI code, organisation name, address, district, state, recognition date, renewal date, and stated validity date.

In this PawPath project, `directory-seed.js` automatically imports the normalized `awbi_organisations.csv` into the shared `directory_entries` table. The SQL file is retained as a source-specific backup and can still be run manually if a separate AWBI-only table is needed.

## What this is—and what it is not

This is the national organisation backbone for PawPath because every imported organisation appears on the national animal-welfare register. It is **not** a guarantee that every organisation:

- is a dog or cat shelter;
- accepts street-animal rescue cases;
- has capacity today; or
- has a publicly callable rescue line.

The source includes gaushalas, SPCAs, trusts, NGOs and other animal-welfare bodies. All imported rows therefore start as `needs_service_verification`, with their dog, cat and stray-case acceptance fields set to `NULL` (unknown).

Only show a card as **Verified for dog/cat rescue** after you contact the organisation and set:

```sql
UPDATE awbi_recognised_organisations
SET
  listing_readiness = 'service_verified',
  accepts_dogs = TRUE,
  accepts_cats = TRUE,        -- only if confirmed
  accepts_stray_cases = TRUE
WHERE awbi_serial = 123;
```

## Import on Render PostgreSQL

Run this once against Render's `DATABASE_URL`:

```bash
psql "$DATABASE_URL" -f india_awbi_2026.sql
```

The import is idempotent: re-running it updates rows by the source serial number rather than creating duplicates.

## Query for the website

Show all official organisations in a selected place:

```sql
SELECT *
FROM awbi_recognised_organisations
WHERE state_normalized = 'Madhya Pradesh'
  AND district ILIKE '%Indore%'
ORDER BY name;
```

Show only listings your team has actually checked for rescue:

```sql
SELECT *
FROM awbi_recognised_organisations
WHERE listing_readiness = 'service_verified'
  AND accepts_stray_cases = TRUE
  AND (accepts_dogs = TRUE OR accepts_cats = TRUE)
ORDER BY state_normalized, district, name;
```

## Relationship to the Indore directory

Keep `indore_animal_directory.sql` too. It contains the small, researched local directory with phone/email/service data for Pop Path's launch city. This national file adds the broad official database; it does not overwrite those curated Indore profiles.

## Source

Animal Welfare Board of India, *List of Animal Welfare Organizations recognised by AWBI (as on 31.03.2026)*:

https://awbi.gov.in/uploads/documents/177608352345Recognition%20List%2031_03_2026_3619.pdf
