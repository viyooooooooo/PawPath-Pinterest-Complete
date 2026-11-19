# PawPath update — 19 November 2026

This build is ready for the existing Render + GitHub deployment flow.

## Included

- Live in-app message, offer and verification events using Server-Sent Events.
- Live chat sending and receiving without refreshing the conversation.
- Automatic listing journey updates when offers are sent or their status changes.
- Accepted listings move to the bottom and use a completed-listing colour treatment.
- Only one offer can remain accepted; the decision UI is replaced by next actions.
- Typed confirmation before accepting an unverified applicant.
- Text and photo journey updates from the listing creator and accepted applicant.
- Vet selection and a vet-owned verification approval queue.
- Automatic profile verification when the selected vet approves.
- Resilient location entry, exact browser pin fallback, and approximate search fallback.
- Signed CAPTCHA tokens so correct answers survive normal Render/session edge cases.
- Removed the “Featured rescue” label from the homepage carousel.

Existing PostgreSQL data is preserved. New columns are added automatically when Render starts the app.

## Follow-up build

- Backfills every historically accepted offer so its animal becomes `Adopted` on deploy.
- Splits Listings into active animals and a green completed section at the absolute bottom.
- Adds a Happy Tails page with three starter stories and adopter photo/story submissions.
- Adds a real “Request an update” action that sends a live chat message to the accepted adopter.
- Makes veterinary registration number, issuing council and certificate compulsory for new vet accounts.
- Separates veterinary certificate verification from ordinary member-to-vet verification.
- Adds an admin veterinary credential queue and prevents unverified vets from reviewing members.
- Reclassifies `vyomika22sahay@gmail.com` as a veterinarian account without falsely marking it verified.
# Happy Tails motion and accepted-listing update

- Accepted animals now keep the exact regular listing-card proportions, with a green treatment and an `ACCEPTED` badge.
- Happy Tails has a new scroll-led hero, animated impact counter, reveal motion, story-card depth and reduced-motion accessibility support.
- Happy Tail photos are optional. PawPath falls back to the animal listing photo, then to a designed no-photo state.
- Explore now includes an animated Happy Tails impact feature.
- The helped counter is calculated from distinct animals with accepted offers, so it updates automatically and cannot drift from the offer workflow.
- `vyomika22sahay@gmail.com` is idempotently promoted to a verified veterinarian during database initialization and can review assigned volunteer applications.

