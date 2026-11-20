const bcrypt = require('bcryptjs');
const { initialiseDatabase, get, run } = require('./database');
const { seedDirectory } = require('./directory-seed');

const DEFAULT_ADMIN = {
  username: 'PawPath Admin',
  email: 'admin@pawpath.in',
  password: 'PawPathAdmin2026!'
};

async function ensureAdminAccount() {
  const username = String(process.env.PAWPATH_ADMIN_USERNAME || DEFAULT_ADMIN.username).trim();
  const email = String(process.env.PAWPATH_ADMIN_EMAIL || DEFAULT_ADMIN.email).trim().toLowerCase();
  const password = String(process.env.PAWPATH_ADMIN_PASSWORD || DEFAULT_ADMIN.password);
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await get('SELECT id FROM users WHERE LOWER(email)=LOWER(?)', [email]);

  if (existing) {
    await run(`UPDATE users SET username=?, password_hash=?, is_admin=1,
      role='Administrator', verification_status='Verified',
      verified_at=COALESCE(verified_at,?) WHERE id=?`,
    [username, passwordHash, new Date().toISOString(), existing.id]);
    return;
  }

  await run(`INSERT INTO users
    (username,email,password_hash,role,locality,verification_status,verified_at,is_admin,entity_type)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    username, email, passwordHash, 'Administrator', 'India', 'Verified',
    new Date().toISOString(), 1, 'Volunteer / rescuer'
  ]);
}

// Production startup imports only the supplied public directory. PawPath no
// longer creates fictional member accounts or fictional animal listings.
async function seed() {
  await initialiseDatabase();
  await ensureAdminAccount();
  const count = await seedDirectory();
  console.log(`PawPath database ready: ${count} source-backed directory records; admin account available.`);
}

seed().catch((error) => { console.error(error); process.exit(1); });
