const fs = require('fs');
const path = require('path');

const usingPostgres = Boolean(process.env.DATABASE_URL);
let sqliteDb;
let pool;

if (usingPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
} else {
  const sqlite3 = require('sqlite3').verbose();
  const dataDirectory = path.join(__dirname, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  sqliteDb = new sqlite3.Database(path.join(dataDirectory, 'pawpath.db'));
  sqliteDb.run('PRAGMA foreign_keys = ON');
}

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`).replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
}

const run = async (sql, params = []) => {
  if (usingPostgres) {
    let query = postgresSql(sql);
    // Most application tables use an integer `id`, but the directory import
    // tracking table is keyed by `source_version`. Asking PostgreSQL to return
    // a nonexistent `id` made the otherwise-successful India import fail at
    // its final bookkeeping step and prevented the web server from starting.
    const insertsDirectoryImport = /^\s*INSERT\s+INTO\s+directory_imports\b/i.test(query);
    if (/^\s*INSERT\s+INTO/i.test(query) && !/\bRETURNING\b/i.test(query) && !insertsDirectoryImport) query += ' RETURNING id';
    const result = await pool.query(query, params);
    return { id: result.rows[0]?.id, changes: result.rowCount };
  }
  return new Promise((resolve, reject) => sqliteDb.run(sql, params, function onRun(error) {
    if (error) reject(error); else resolve({ id: this.lastID, changes: this.changes });
  }));
};

const get = async (sql, params = []) => {
  if (usingPostgres) return (await pool.query(postgresSql(sql), params)).rows[0];
  return new Promise((resolve, reject) => sqliteDb.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
};

const all = async (sql, params = []) => {
  if (usingPostgres) return (await pool.query(postgresSql(sql), params)).rows;
  return new Promise((resolve, reject) => sqliteDb.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
};

async function addColumn(table, definition) {
  try { await run(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch (error) {
    if (!/duplicate column|already exists/i.test(error.message)) throw error;
  }
}

async function allowGeneralConversations() {
  if (usingPostgres) {
    await run('ALTER TABLE conversations ALTER COLUMN listing_id DROP NOT NULL');
    return;
  }
  const columns = await all('PRAGMA table_info(conversations)');
  const listingColumn = columns.find((column) => column.name === 'listing_id');
  if (!listingColumn || Number(listingColumn.notnull) !== 1) return;

  // SQLite cannot remove a NOT NULL constraint in place, so rebuild these two
  // small related tables once while preserving every existing chat and message.
  await run('PRAGMA foreign_keys = OFF');
  await run(`CREATE TABLE conversations_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER,
    initiator_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
    compatibility_score INTEGER NOT NULL DEFAULT 0, topic TEXT,
    initiator_read_at TEXT, recipient_read_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(listing_id, initiator_id, recipient_id),
    FOREIGN KEY (listing_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (initiator_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('INSERT INTO conversations_new (id,listing_id,initiator_id,recipient_id,compatibility_score,topic,initiator_read_at,recipient_read_at,created_at,updated_at) SELECT id,listing_id,initiator_id,recipient_id,compatibility_score,topic,initiator_read_at,recipient_read_at,created_at,updated_at FROM conversations');
  await run(`CREATE TABLE messages_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations_new(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('INSERT INTO messages_new (id,conversation_id,sender_id,body,created_at) SELECT id,conversation_id,sender_id,body,created_at FROM messages');
  await run('DROP TABLE messages');
  await run('DROP TABLE conversations');
  await run('ALTER TABLE conversations_new RENAME TO conversations');
  await run('ALTER TABLE messages_new RENAME TO messages');
  await run('PRAGMA foreign_keys = ON');
}

async function initialiseDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'Community member', bio TEXT, locality TEXT,
    profile_photo TEXT, verification_status TEXT NOT NULL DEFAULT 'Unverified', verified_at TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
    entity_type TEXT NOT NULL DEFAULT 'Volunteer / rescuer', organisation_name TEXT,
    phone TEXT, show_phone INTEGER NOT NULL DEFAULT 0, public_email TEXT, show_public_email INTEGER NOT NULL DEFAULT 0,
    instagram_handle TEXT, show_instagram INTEGER NOT NULL DEFAULT 0, website TEXT, show_website INTEGER NOT NULL DEFAULT 0,
    verification_document TEXT,
    vet_registration_number TEXT, vet_council_name TEXT,
    vet_certificate_status TEXT NOT NULL DEFAULT 'Not submitted', vet_certificate_provider TEXT,
    vet_certificate_reference TEXT, vet_certificate_notes TEXT,
    latitude REAL, longitude REAL, location_accuracy TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn('users', "role TEXT NOT NULL DEFAULT 'Community member'");
  await addColumn('users', 'bio TEXT');
  await addColumn('users', 'locality TEXT');
  await addColumn('users', 'profile_photo TEXT');
  await addColumn('users', "verification_status TEXT NOT NULL DEFAULT 'Unverified'");
  await addColumn('users', 'verified_at TEXT');
  await addColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', "entity_type TEXT NOT NULL DEFAULT 'Volunteer / rescuer'");
  await addColumn('users', 'organisation_name TEXT');
  await addColumn('users', 'phone TEXT');
  await addColumn('users', 'show_phone INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'public_email TEXT');
  await addColumn('users', 'show_public_email INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'instagram_handle TEXT');
  await addColumn('users', 'show_instagram INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'website TEXT');
  await addColumn('users', 'show_website INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'verification_document TEXT');
  await addColumn('users', 'vet_registration_number TEXT');
  await addColumn('users', 'vet_council_name TEXT');
  await addColumn('users', "vet_certificate_status TEXT NOT NULL DEFAULT 'Not submitted'");
  await addColumn('users', 'vet_certificate_provider TEXT');
  await addColumn('users', 'vet_certificate_reference TEXT');
  await addColumn('users', 'vet_certificate_notes TEXT');
  await addColumn('users', 'latitude REAL');
  await addColumn('users', 'longitude REAL');
  await addColumn('users', 'location_accuracy TEXT');

  // Public directory records are kept separate from PawPath accounts. Imported
  // contacts cannot log in or receive in-app messages, and their source status
  // is never presented as PawPath identity verification.
  await run(`CREATE TABLE IF NOT EXISTS directory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    subtype TEXT,
    city TEXT,
    state TEXT,
    address TEXT,
    phone_primary TEXT,
    phone_secondary TEXT,
    email TEXT,
    services TEXT,
    notes TEXT,
    trust_status TEXT NOT NULL DEFAULT 'source_listed',
    source_url TEXT,
    source_checked_on TEXT,
    awbi_code TEXT,
    listing_readiness TEXT,
    accepts_dogs INTEGER,
    accepts_cats INTEGER,
    accepts_stray_cases INTEGER,
    latitude REAL,
    longitude REAL,
    location_accuracy TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_directory_category ON directory_entries (category)');
  await run('CREATE INDEX IF NOT EXISTS idx_directory_state_city ON directory_entries (state, city)');
  await run('CREATE INDEX IF NOT EXISTS idx_directory_trust ON directory_entries (trust_status)');
  await addColumn('directory_entries', 'latitude REAL');
  await addColumn('directory_entries', 'longitude REAL');
  await addColumn('directory_entries', 'location_accuracy TEXT');

  await run(`CREATE TABLE IF NOT EXISTS directory_imports (
    source_version TEXT PRIMARY KEY,
    record_count INTEGER NOT NULL,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS animals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, species TEXT NOT NULL,
    species_other TEXT,
    gender TEXT NOT NULL, age TEXT NOT NULL, size TEXT NOT NULL, colour TEXT NOT NULL, temperament TEXT NOT NULL,
    vaccinated TEXT NOT NULL, vaccinations_done TEXT, vaccinations_required TEXT, sterilised TEXT NOT NULL, medical_notes TEXT, locality TEXT NOT NULL,
    urgency TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Reported', photo_url TEXT,
    description TEXT NOT NULL, contact_details TEXT, latitude REAL, longitude REAL, location_accuracy TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('animals', 'contact_details TEXT');
  await addColumn('animals', 'latitude REAL');
  await addColumn('animals', 'longitude REAL');
  await addColumn('animals', 'location_accuracy TEXT');
  await addColumn('animals', 'species_other TEXT');
  await addColumn('animals', 'vaccinations_done TEXT');
  await addColumn('animals', 'vaccinations_required TEXT');

  await run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    request_type TEXT NOT NULL, housing_type TEXT NOT NULL, locality TEXT NOT NULL, pet_experience TEXT NOT NULL,
    working_hours TEXT NOT NULL, contact_number TEXT NOT NULL, message TEXT NOT NULL,
    compatibility_score INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', share_contact INTEGER NOT NULL DEFAULT 1,
    share_profile INTEGER NOT NULL DEFAULT 1, share_verification INTEGER NOT NULL DEFAULT 0,
    support_document TEXT, support_document_name TEXT, owner_note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('applications', "status TEXT NOT NULL DEFAULT 'Pending'");
  await addColumn('applications', 'share_contact INTEGER NOT NULL DEFAULT 1');
  await addColumn('applications', 'share_profile INTEGER NOT NULL DEFAULT 1');
  await addColumn('applications', 'share_verification INTEGER NOT NULL DEFAULT 0');
  await addColumn('applications', 'support_document TEXT');
  await addColumn('applications', 'support_document_name TEXT');
  await addColumn('applications', 'owner_note TEXT');
  await addColumn('applications', 'updated_at TEXT');

  await run(`CREATE TABLE IF NOT EXISTS rescue_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    update_text TEXT NOT NULL, update_type TEXT NOT NULL DEFAULT 'Progress update', photo_url TEXT, is_automatic INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('rescue_updates', 'photo_url TEXT');
  await addColumn('rescue_updates', 'is_automatic INTEGER NOT NULL DEFAULT 0');

  await run(`CREATE TABLE IF NOT EXISTS verification_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, applicant_type TEXT NOT NULL,
    full_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, government_id_type TEXT NOT NULL,
    government_id_reference TEXT NOT NULL, veterinarian_name TEXT NOT NULL, veterinarian_clinic TEXT NOT NULL,
    veterinarian_contact TEXT NOT NULL, residence_proof_reference TEXT NOT NULL, pet_experience TEXT NOT NULL,
    household_consent TEXT NOT NULL, home_visit_consent TEXT NOT NULL, welfare_commitment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Under review', reviewer_notes TEXT,
    proof_document TEXT,
    selected_vet_user_id INTEGER, reviewed_by_user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('verification_applications', 'proof_document TEXT');
  await addColumn('verification_applications', 'selected_vet_user_id INTEGER');
  await addColumn('verification_applications', 'reviewed_by_user_id INTEGER');

  await run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER,
    initiator_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    compatibility_score INTEGER NOT NULL,
    topic TEXT,
    initiator_read_at TEXT,
    recipient_read_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(listing_id, initiator_id, recipient_id),
    FOREIGN KEY (listing_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (initiator_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('conversations', 'topic TEXT');
  await addColumn('conversations', 'initiator_read_at TEXT');
  await addColumn('conversations', 'recipient_read_at TEXT');

  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    dismissed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, dismissed_at, is_read)');

  await run(`CREATE TABLE IF NOT EXISTS happy_tails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    animal_id INTEGER,
    dog_name TEXT NOT NULL,
    title TEXT NOT NULL,
    story_text TEXT NOT NULL,
    after_photo_url TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE SET NULL
  )`);

  // Keep listings accepted before this release consistent with the new
  // completed-listing layout. This is safe and idempotent on every deploy.
  await run("UPDATE animals SET status='Adopted' WHERE id IN (SELECT animal_id FROM applications WHERE status='Accepted') AND status NOT IN ('Adopted','Resolved')");

  // Requested account correction: classify this existing member as a vet.
  // Verification is deliberately not granted until a certificate is reviewed.
  await run(`UPDATE users SET entity_type='Veterinarian / vet clinic', role='Veterinarian',
    vet_certificate_status=CASE WHEN COALESCE(verification_document,'')='' THEN 'Not submitted' ELSE 'Under review' END
    WHERE LOWER(email)='vyomika22sahay@gmail.com'`);
  await allowGeneralConversations();
  // The SQLite compatibility rebuild above can replace the conversations table.
  // Re-assert these columns afterwards so upgrades from every older schema work.
  await addColumn('conversations', 'initiator_read_at TEXT');
  await addColumn('conversations', 'recipient_read_at TEXT');
}

module.exports = { run, get, all, initialiseDatabase, usingPostgres };
