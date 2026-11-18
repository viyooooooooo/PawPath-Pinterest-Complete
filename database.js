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
    if (/^\s*INSERT\s+INTO/i.test(query) && !/\bRETURNING\b/i.test(query)) query += ' RETURNING id';
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

async function initialiseDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'Community member', bio TEXT, locality TEXT,
    profile_photo TEXT, verification_status TEXT NOT NULL DEFAULT 'Unverified', verified_at TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn('users', "role TEXT NOT NULL DEFAULT 'Community member'");
  await addColumn('users', 'bio TEXT');
  await addColumn('users', 'locality TEXT');
  await addColumn('users', 'profile_photo TEXT');
  await addColumn('users', "verification_status TEXT NOT NULL DEFAULT 'Unverified'");
  await addColumn('users', 'verified_at TEXT');
  await addColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0');

  await run(`CREATE TABLE IF NOT EXISTS animals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, species TEXT NOT NULL,
    gender TEXT NOT NULL, age TEXT NOT NULL, size TEXT NOT NULL, colour TEXT NOT NULL, temperament TEXT NOT NULL,
    vaccinated TEXT NOT NULL, sterilised TEXT NOT NULL, medical_notes TEXT, locality TEXT NOT NULL,
    urgency TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Reported', photo_url TEXT,
    description TEXT NOT NULL, contact_details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumn('animals', 'contact_details TEXT');

  await run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    request_type TEXT NOT NULL, housing_type TEXT NOT NULL, locality TEXT NOT NULL, pet_experience TEXT NOT NULL,
    working_hours TEXT NOT NULL, contact_number TEXT NOT NULL, message TEXT NOT NULL,
    compatibility_score INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS rescue_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    update_text TEXT NOT NULL, update_type TEXT NOT NULL DEFAULT 'Progress update', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS verification_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, applicant_type TEXT NOT NULL,
    full_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, government_id_type TEXT NOT NULL,
    government_id_reference TEXT NOT NULL, veterinarian_name TEXT NOT NULL, veterinarian_clinic TEXT NOT NULL,
    veterinarian_contact TEXT NOT NULL, residence_proof_reference TEXT NOT NULL, pet_experience TEXT NOT NULL,
    household_consent TEXT NOT NULL, home_visit_consent TEXT NOT NULL, welfare_commitment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Under review', reviewer_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    initiator_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    compatibility_score INTEGER NOT NULL,
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
}

module.exports = { run, get, all, initialiseDatabase, usingPostgres };
