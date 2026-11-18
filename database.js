const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(path.join(__dirname, 'data', 'pawpath.db'));
db.run('PRAGMA foreign_keys = ON');

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
});

async function initialiseDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS animals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    species TEXT NOT NULL,
    gender TEXT NOT NULL,
    age TEXT NOT NULL,
    size TEXT NOT NULL,
    colour TEXT NOT NULL,
    temperament TEXT NOT NULL,
    vaccinated TEXT NOT NULL,
    sterilised TEXT NOT NULL,
    medical_notes TEXT,
    locality TEXT NOT NULL,
    urgency TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Reported',
    photo_url TEXT,
    description TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    animal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    request_type TEXT NOT NULL,
    housing_type TEXT NOT NULL,
    locality TEXT NOT NULL,
    pet_experience TEXT NOT NULL,
    working_hours TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    message TEXT NOT NULL,
    compatibility_score INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS rescue_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    animal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    update_text TEXT NOT NULL,
    update_type TEXT NOT NULL DEFAULT 'Progress update',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
}

module.exports = { db, run, get, all, initialiseDatabase };
