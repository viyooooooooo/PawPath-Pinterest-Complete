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

# Accountability, referrals and unified Happy Tails update

- Opening a notification now marks it read and dismisses it immediately.
- Happy Tails now uses the core PawPath cream/ink/green/red palette, an image-filled impact numeral, scroll zoom, and a one-at-a-time selectable story-card deck.
- Added verified-member accountability complaints for profiles and source-backed directory records. Three distinct verified reporters trigger a clearly worded unresolved-concerns caution; one reporter cannot inflate the threshold.
- Added secure directory-vet referrals: applicants can choose a public-directory vet, copy a tokenized link, and send it to the vet. The vet must create a veterinarian account and complete professional credential verification before claiming and reviewing the application.
- Removed bundled `@pawpath.local` demo people and stopped creating fictional accounts, listings, or Happy Tail stories. User-created records and supplied public-directory records remain intact.
- Added source-attributed supplemental organisation contact import support through `data/imports/organisation_contacts.csv`. The supplied AWBI file contains no phone/email fields, so missing contacts are not fabricated.

# Verification and visual-experience repair

- Verification submission now handles missing/stale veterinarian selections safely and returns the filled form with a useful error instead of the generic error page.
- Private verification proof uploads now accept files up to 12 MB, with clearer PDF/image validation messages.
- Explore hero photographs now display inside a full-photo frame over a softened backdrop so portrait and landscape uploads are not heavily cropped.
- Removed the small green kicker/eyebrow labels above headings across the interface.
- Added a site-wide motion and surface polish layer with stronger cards, forms, focus states and responsive transitions.
- Happy Tails now uses a low-opacity editorial collage of street dogs and cats in the hero.
- The impact number is solid PawPath green and enters with a count-up animation; the four surrounding animal tiles animate independently.
- Happy Tail cards change only when a story name is clicked. Wheel/scroll-driven card switching and scroll-linked photo motion were removed.
- Members can delete only the Happy Tail stories they personally published.

# Real-photo and responsive-layout polish

- Happy Tales now builds its hero and impact collage from up to seven real dog photos already uploaded to PawPath listings. It no longer relies on Pinterest hotlinks or generated collage crops.
- The impact number stays solid PawPath green while the listing photos animate around it.
- The profile messaging/suggestion interface now constrains long listing names, selects, text areas and buttons to their card, removing horizontal overflow.
- The Explore carousel uses the supplied watercolor green-paw artwork instead of the black background.
- Explore photos use a contained, non-scrolling frame so portrait and landscape uploads remain visible without sliding outside the frame.
- The Explore network orbit now includes a PawPath paw inside a small earth-style globe.
- The watercolor paw artwork is now clearly visible behind the Explore rescue carousel.
- Each featured dog receives a different editorial headline instead of repeating “needs a safe next step.”

