# Veterinary credential verification

PawPath currently uses a safe two-stage flow:

1. A veterinarian must upload a certificate/professional ID and provide the registration number and issuing council.
2. A PawPath admin compares those details with the Veterinary Council of India or relevant State Veterinary Council register, then approves or rejects the account.

The account is never automatically marked `Verified` merely because a document was uploaded.

## External verification option

IDfy provides background-verification APIs, including qualification verification and a marketed doctor-certificate verification product. A production connection requires a commercial IDfy account, an API key, a company/package ID, user consent, and confirmation from IDfy that the purchased check covers veterinary registrations—not only human medical registrations.

- API documentation: https://bgv-api-docs.idfy.com/
- Product overview: https://www.idfy.com/identity-verification-solutions-by-idfy/api-solutions-overview/
- VCI practitioner registers: https://vci.dahd.gov.in/ivpr

No external auto-approval is enabled in this ZIP because no provider credentials were supplied and the public VCI site does not document a real-time verification API. This avoids presenting an OCR/document scan as proof that a person is genuinely registered.
