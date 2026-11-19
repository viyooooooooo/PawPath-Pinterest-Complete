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
