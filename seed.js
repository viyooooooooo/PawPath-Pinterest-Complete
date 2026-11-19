const { initialiseDatabase } = require('./database');
const { seedDirectory } = require('./directory-seed');

// Production startup imports only the supplied public directory. PawPath no
// longer creates fictional member accounts or fictional animal listings.
async function seed() {
  await initialiseDatabase();
  const count = await seedDirectory();
  console.log(`PawPath database ready: ${count} source-backed directory records; no demo people created.`);
}

seed().catch((error) => { console.error(error); process.exit(1); });
