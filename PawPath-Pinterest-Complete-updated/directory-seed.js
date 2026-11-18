const fs = require('fs');
const path = require('path');
const { run, get, initialiseDatabase } = require('./database');
const { parseCsv } = require('./data-utils');

const SOURCE_VERSION = 'india-directory-2026-11-18-v1';
const IMPORT_DIRECTORY = path.join(__dirname, 'data', 'imports');

function readCsv(filename) {
  return parseCsv(fs.readFileSync(path.join(IMPORT_DIRECTORY, filename), 'utf8').replace(/^\uFEFF/, ''));
}

function nullableBoolean(value) {
  if (value === '' || value == null) return null;
  return ['1', 'true', 'yes'].includes(String(value).trim().toLowerCase()) ? 1 : 0;
}

function volunteerEntries() {
  return readCsv('individual_rescuers_volunteers.csv').map((row) => ({
    source_key: `volunteer:${row.id}`,
    category: 'volunteers',
    name: row.full_name,
    subtype: row.role,
    city: row.city,
    state: row.state,
    address: '',
    phone_primary: row.phone_primary,
    phone_secondary: row.phone_secondary,
    email: row.email,
    services: [row.public_affiliation, row.service_scope].filter(Boolean).join(' · '),
    notes: row.availability_notes,
    trust_status: row.verification_status || 'source_verified',
    source_url: row.source_url,
    source_checked_on: row.source_checked_on,
    awbi_code: '',
    listing_readiness: 'contact_source_checked',
    accepts_dogs: null,
    accepts_cats: null,
    accepts_stray_cases: null
  }));
}

function veterinaryEntries() {
  return readCsv('vets_and_clinics.csv').map((row) => ({
    source_key: `vet:${row.id}`,
    category: 'vets',
    name: row.name,
    subtype: row.record_type,
    city: row.city,
    state: row.state,
    address: row.address,
    phone_primary: row.phone_primary,
    phone_secondary: row.phone_secondary,
    email: row.email,
    services: row.services,
    notes: row.hours_or_notes,
    trust_status: row.verification_status || 'official_source',
    source_url: row.source_url,
    source_checked_on: row.source_checked_on,
    awbi_code: '',
    listing_readiness: row.stray_support_status || 'call_to_confirm',
    accepts_dogs: null,
    accepts_cats: null,
    accepts_stray_cases: row.stray_support_status === 'confirmed' ? 1 : null
  }));
}

function organisationEntries() {
  return readCsv('awbi_organisations.csv').map((row) => ({
    source_key: `awbi:${row.awbi_serial}`,
    category: 'organisations',
    name: row.name,
    subtype: 'AWBI-recognised animal-welfare organisation',
    city: row.district,
    state: row.state_normalized,
    address: row.address,
    phone_primary: '',
    phone_secondary: '',
    email: '',
    services: 'Listed on the national AWBI register. Current dog, cat and stray-case services are not yet confirmed by PawPath.',
    notes: `Recognition: ${row.recognition_date_raw || 'Not stated'} · Renewal: ${row.renewal_date_raw || 'Not stated'} · Valid until: ${row.valid_upto_raw || 'Not stated'}`,
    trust_status: 'awbi_recognised',
    source_url: row.source_url,
    source_checked_on: '2026-03-31',
    awbi_code: row.awbi_code,
    listing_readiness: row.listing_readiness || 'needs_service_verification',
    accepts_dogs: nullableBoolean(row.accepts_dogs),
    accepts_cats: nullableBoolean(row.accepts_cats),
    accepts_stray_cases: nullableBoolean(row.accepts_stray_cases)
  }));
}

const columns = [
  'source_key', 'category', 'name', 'subtype', 'city', 'state', 'address',
  'phone_primary', 'phone_secondary', 'email', 'services', 'notes', 'trust_status',
  'source_url', 'source_checked_on', 'awbi_code', 'listing_readiness',
  'accepts_dogs', 'accepts_cats', 'accepts_stray_cases'
];

async function upsertBatch(entries) {
  const rowPlaceholders = `(${columns.map(() => '?').join(',')})`;
  const values = entries.flatMap((entry) => columns.map((column) => entry[column] ?? null));
  await run(`INSERT INTO directory_entries (${columns.join(',')}) VALUES ${entries.map(() => rowPlaceholders).join(',')}
    ON CONFLICT (source_key) DO UPDATE SET
      category=EXCLUDED.category,
      name=EXCLUDED.name,
      subtype=EXCLUDED.subtype,
      city=EXCLUDED.city,
      state=EXCLUDED.state,
      address=EXCLUDED.address,
      phone_primary=EXCLUDED.phone_primary,
      phone_secondary=EXCLUDED.phone_secondary,
      email=EXCLUDED.email,
      services=EXCLUDED.services,
      notes=EXCLUDED.notes,
      trust_status=EXCLUDED.trust_status,
      source_url=EXCLUDED.source_url,
      source_checked_on=EXCLUDED.source_checked_on,
      awbi_code=EXCLUDED.awbi_code,
      listing_readiness=CASE WHEN directory_entries.category='organisations' THEN directory_entries.listing_readiness ELSE EXCLUDED.listing_readiness END,
      accepts_dogs=CASE WHEN directory_entries.category='organisations' THEN directory_entries.accepts_dogs ELSE EXCLUDED.accepts_dogs END,
      accepts_cats=CASE WHEN directory_entries.category='organisations' THEN directory_entries.accepts_cats ELSE EXCLUDED.accepts_cats END,
      accepts_stray_cases=CASE WHEN directory_entries.category='organisations' THEN directory_entries.accepts_stray_cases ELSE EXCLUDED.accepts_stray_cases END,
      updated_at=CURRENT_TIMESTAMP`, values);
}

async function seedDirectory() {
  const completed = await get('SELECT source_version, record_count FROM directory_imports WHERE source_version=?', [SOURCE_VERSION]);
  if (completed) {
    console.log(`PawPath directory already current: ${completed.record_count} imported records.`);
    return Number(completed.record_count);
  }

  const entries = [...volunteerEntries(), ...veterinaryEntries(), ...organisationEntries()];
  for (let index = 0; index < entries.length; index += 20) {
    await upsertBatch(entries.slice(index, index + 20));
  }
  await run('INSERT INTO directory_imports (source_version,record_count) VALUES (?,?) ON CONFLICT (source_version) DO NOTHING', [SOURCE_VERSION, entries.length]);
  console.log(`PawPath India directory imported: ${entries.length} records.`);
  return entries.length;
}

module.exports = { seedDirectory, parseCsv, SOURCE_VERSION };

if (require.main === module) {
  initialiseDatabase()
    .then(seedDirectory)
    .catch((error) => { console.error(error); process.exit(1); });
}
