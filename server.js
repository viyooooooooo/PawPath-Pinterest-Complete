const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const { run, get, all, initialiseDatabase } = require('./database');
const { coordinatesForPlace } = require('./geo-utils');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates HTTPS at its proxy. Trusting that proxy keeps secure
// session cookies available across the captcha form request and submission.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: process.env.SESSION_SECRET || 'pawpath-local-demo-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, done) => done(/^image\//.test(file.mimetype) ? null : new Error('Please choose an image file.'), /^image\//.test(file.mimetype))
});
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, done) => {
    const allowed = /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf';
    done(allowed ? null : new Error('Please upload a PDF or image file.'), allowed);
  }
});

const networkGroups = {
  volunteers: { label: 'Volunteers, rescuers & helpers', values: ['Volunteer / rescuer'] },
  vets: { label: 'Veterinarians & vet clinics', values: ['Veterinarian / vet clinic'] },
  organisations: { label: 'Shelters, NGOs & rescue organisations', values: ['Shelter / NGO / rescue organisation'] }
};
const NETWORK_PAGE_SIZE = 24;
const locationCache = new Map();
let lastGeocoderRequestAt = 0;
const liveClients = new Map();
const networkDirectoryCte = `WITH network AS (
  SELECT
    'user' AS source_type,
    CAST(users.id AS TEXT) AS record_id,
    users.username AS name,
    CASE
      WHEN users.entity_type='Veterinarian / vet clinic' THEN 'vets'
      WHEN users.entity_type='Shelter / NGO / rescue organisation' THEN 'organisations'
      ELSE 'volunteers'
    END AS category,
    COALESCE(users.entity_type, users.role) AS subtype,
    '' AS city,
    '' AS state,
    COALESCE(users.locality, '') AS location,
    COALESCE(users.bio, '') AS description,
    CASE WHEN users.show_phone=1 THEN COALESCE(users.phone, '') ELSE '' END AS phone_primary,
    '' AS phone_secondary,
    CASE WHEN users.show_public_email=1 THEN COALESCE(users.public_email, '') ELSE '' END AS public_email,
    CASE WHEN users.show_website=1 THEN COALESCE(users.website, '') ELSE '' END AS website,
    CASE WHEN users.show_instagram=1 THEN COALESCE(users.instagram_handle, '') ELSE '' END AS instagram_handle,
    '' AS source_url,
    users.verification_status AS trust_status,
    '' AS source_checked_on,
    '' AS awbi_code,
    '' AS listing_readiness,
    users.profile_photo AS profile_photo,
    users.organisation_name AS organisation_name,
    users.role AS role,
    COUNT(animals.id) AS listing_count
  FROM users
  LEFT JOIN animals ON animals.user_id=users.id
  GROUP BY users.id
  UNION ALL
  SELECT
    'directory' AS source_type,
    CAST(directory_entries.id AS TEXT) AS record_id,
    directory_entries.name,
    directory_entries.category,
    COALESCE(directory_entries.subtype, '') AS subtype,
    COALESCE(directory_entries.city, '') AS city,
    COALESCE(directory_entries.state, '') AS state,
    CASE
      WHEN COALESCE(directory_entries.city, '')='' THEN COALESCE(directory_entries.state, '')
      WHEN COALESCE(directory_entries.state, '')='' THEN directory_entries.city
      ELSE directory_entries.city || ', ' || directory_entries.state
    END AS location,
    COALESCE(directory_entries.services, '') AS description,
    COALESCE(directory_entries.phone_primary, '') AS phone_primary,
    COALESCE(directory_entries.phone_secondary, '') AS phone_secondary,
    COALESCE(directory_entries.email, '') AS public_email,
    COALESCE(directory_entries.website, '') AS website,
    '' AS instagram_handle,
    COALESCE(directory_entries.source_url, '') AS source_url,
    directory_entries.trust_status,
    COALESCE(directory_entries.source_checked_on, '') AS source_checked_on,
    COALESCE(directory_entries.awbi_code, '') AS awbi_code,
    COALESCE(directory_entries.listing_readiness, '') AS listing_readiness,
    '' AS profile_photo,
    '' AS organisation_name,
    directory_entries.subtype AS role,
    0 AS listing_count
  FROM directory_entries
)`;

function safeWebsite(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (error) { return ''; }
}
function proofFromRequest(req, existing = '') {
  if (!req.file) return existing;
  return `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
}
function listValue(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function requestCoordinates(body, fallbackLocation, seed) {
  if (String(body.latitude ?? '').trim() === '' || String(body.longitude ?? '').trim() === '') return coordinatesForPlace(fallbackLocation, '', seed);
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
    return { latitude, longitude, location_accuracy: body.location_accuracy || 'exact' };
  }
  return coordinatesForPlace(fallbackLocation, '', seed);
}
async function createNotification(userId, sourceKey, type, title, body, url) {
  const existing = await get('SELECT id FROM notifications WHERE source_key=?', [sourceKey]);
  if (existing) return existing.id;
  const result = await run('INSERT INTO notifications (user_id,source_key,type,title,body,url) VALUES (?,?,?,?,?,?)', [userId, sourceKey, type, title, body, url]);
  return result.id;
}
function maskedReference(value) {
  const text = String(value || '');
  return text.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}

async function seedHappyTails() {
  const existing = await get('SELECT COUNT(*) AS count FROM happy_tails');
  if (Number(existing?.count || 0) > 0) return;
  const animals = await all(`SELECT animals.id,animals.user_id,animals.name,animals.photo_url FROM animals WHERE animals.species='Dog' AND COALESCE(animals.photo_url,'')<>'' ORDER BY animals.created_at DESC LIMIT 3`);
  const examples = [
    ['From roadside naps to sofa naps', 'The first few days were quiet, but soon this little one discovered sunny windows, squeaky toys and a favourite corner of the sofa. Now every morning begins with a wagging tail and a very serious breakfast inspection.'],
    ['A home full of tiny adventures', 'What started as a rescue became the happiest part of our routine. Walks are longer, the house is louder, and every visitor is greeted like a long-lost best friend.'],
    ['Safe, loved and finally home', 'After patient introductions and lots of treats, home began to feel safe. The shy eyes are brighter now, and bedtime always ends with one paw resting on someone nearby.']
  ];
  for (let index = 0; index < animals.length; index += 1) {
    const animal = animals[index]; const [title, story] = examples[index];
    await run('INSERT INTO happy_tails (user_id,animal_id,dog_name,title,story_text,after_photo_url) VALUES (?,?,?,?,?,?)', [animal.user_id, animal.id, animal.name, title, story, animal.photo_url]);
  }
}

function freshCaptcha(req) {
  const first = Math.floor(Math.random() * 8) + 2;
  const second = Math.floor(Math.random() * 8) + 1;
  req.session.captcha = { question: `${first} + ${second}`, answer: String(first + second) };
}
function captchaToken(captcha) {
  const payload = `${captcha.question}|${captcha.answer}|${Date.now()}`;
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'pawpath-local-demo-secret').update(payload).digest('hex');
  return Buffer.from(`${payload}|${signature}`).toString('base64url');
}
function captchaOk(req, answer, token) {
  let signedCorrect = false;
  try {
    const decoded = Buffer.from(String(token || ''), 'base64url').toString();
    const parts = decoded.split('|');
    const [question, expected, createdAt, signature] = parts;
    const payload = `${question}|${expected}|${createdAt}`;
    const actual = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'pawpath-local-demo-secret').update(payload).digest('hex');
    signedCorrect = parts.length === 4 && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(signature || '')) && Date.now() - Number(createdAt) < 1000 * 60 * 60 * 2 && String(answer || '').trim() === expected;
  } catch (error) { signedCorrect = false; }
  const correct = signedCorrect || Boolean(req.session.captcha && String(answer || '').trim() === req.session.captcha.answer);
  freshCaptcha(req);
  return correct;
}
function pushLive(userId, event, payload) {
  const clients = liveClients.get(Number(userId));
  if (!clients) return;
  for (const response of clients) response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function flash(req, type, text) { req.session.flash = { type, text }; }
function requireLogin(req, res, next) {
  if (!req.session.user) { flash(req, 'error', 'Please log in to continue.'); return res.redirect('/login'); }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user?.is_admin) { flash(req, 'error', 'Reviewer access is required.'); return res.redirect('/dashboard'); }
  next();
}
function validateAnimal(body) {
  const errors = [];
  const required = ['name', 'locality', 'location_status'];
  required.forEach((field) => { if (!String(body[field] || '').trim()) errors.push(`${field.replace('_', ' ')} is required.`); });
  if (body.location_status && !['with_lister', 'last_spotted'].includes(body.location_status)) errors.push('Choose whether the animal is currently with you or was last spotted elsewhere.');
  return errors;
}

function photoFromRequest(req, existingPhoto = '') {
  if (req.body.remove_photo === 'on') return '';
  if (req.file) return `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  return existingPhoto;
}

function listingValues(body, photoUrl) {
  const locality = String(body.locality || '').trim();
  const coordinates = requestCoordinates(body, locality, `listing:${body.name || ''}:${locality}`);
  const category = body.category || 'Up for Adoption';
  const urgency = category === 'Medical / Rescue SOS' && (!body.urgency || body.urgency === 'Normal')
    ? 'Needs Help Today'
    : body.urgency || 'Normal';
  const vaccinationNames = listValue(body.vaccination_name);
  const vaccinationDates = listValue(body.vaccination_date);
  const vaccinationsDone = vaccinationNames.map((name, index) => ({ name: String(name || '').trim(), date: String(vaccinationDates[index] || '').trim() })).filter((item) => item.name);
  return [
    String(body.name || '').trim(), body.species || 'Unknown', body.species === 'Other' ? String(body.species_other || '').trim() : '', body.gender || 'Unknown', String(body.age || '').trim() || 'Unknown',
    body.size || 'Unknown', String(body.colour || '').trim() || 'Not added', String(body.temperament || '').trim() || 'Not added',
    body.vaccinated || 'Unknown', JSON.stringify(vaccinationsDone), String(body.vaccinations_required || '').trim(), body.sterilised || 'Unknown', String(body.medical_notes || '').trim(), locality, body.location_status || 'last_spotted',
    urgency, category, body.status || 'Reported', photoUrl,
    String(body.description || '').trim() || 'No description added yet.', String(body.contact_details || '').trim(),
    coordinates.latitude, coordinates.longitude, coordinates.location_accuracy
  ];
}
function compatibility(body) {
  let score = 50;
  if (body.pet_experience !== 'None') score += 15;
  if (body.housing_type !== 'Hostel / shared room') score += 15;
  if (Number(body.working_hours) <= 8) score += 10;
  return Math.min(score, 95);
}

function listingMatchScore(listing, profile) {
  let score = 56;
  if (profile.verification_status === 'Verified') score += 18;
  if (['Verified adopter', 'Foster volunteer', 'Independent rescuer'].includes(profile.role)) score += 10;
  if (listing.category === 'Up for Adoption' && profile.role === 'Verified adopter') score += 9;
  if (listing.category === 'Urgent Foster Needed' && profile.role === 'Foster volunteer') score += 9;
  return Math.min(score, 96);
}

app.use(async (req, res, next) => {
  if (!req.session.captcha) freshCaptcha(req);
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.captcha = req.session.captcha;
  res.locals.captchaToken = captchaToken(req.session.captcha);
  res.locals.currentPath = req.path;
  res.locals.unreadNotifications = 0;
  res.locals.unreadMessages = 0;
  res.locals.notificationAlerts = [];
  delete req.session.flash;
  if (!req.session.user) return next();
  try {
    const userId = req.session.user.id;
    const unannouncedOffers = await all(`SELECT applications.id,applications.request_type,animals.name AS animal_name,users.username AS applicant_name
      FROM applications JOIN animals ON animals.id=applications.animal_id JOIN users ON users.id=applications.user_id
      WHERE animals.user_id=?`, [userId]);
    for (const offer of unannouncedOffers) await createNotification(userId, `offer-${offer.id}`, 'offer', `Offer for ${offer.animal_name}`, `${offer.applicant_name} offered ${offer.request_type.toLowerCase()}.`, `/offers/${offer.id}`);
    const notificationCount = await get('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND dismissed_at IS NULL AND is_read=0', [userId]);
    const messageCount = await get(`SELECT COUNT(*) AS count FROM messages JOIN conversations ON conversations.id=messages.conversation_id
      WHERE (conversations.initiator_id=? OR conversations.recipient_id=?) AND messages.sender_id<>?
      AND messages.created_at > COALESCE(CASE WHEN conversations.initiator_id=? THEN conversations.initiator_read_at ELSE conversations.recipient_read_at END, '1970-01-01')`, [userId, userId, userId, userId]);
    res.locals.unreadNotifications = Number(notificationCount?.count || 0);
    res.locals.unreadMessages = Number(messageCount?.count || 0);
    // Opening an alert marks it read for the badge, but it remains visible until
    // the person explicitly dismisses it with the × button.
    res.locals.notificationAlerts = await all('SELECT * FROM notifications WHERE user_id=? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 3', [userId]);
    next();
  } catch (error) { next(error); }
});

app.get('/', async (req, res, next) => {
  try {
    const urgent = await all(`SELECT * FROM animals WHERE urgency IN ('Critical', 'Needs Help Today') AND status NOT IN ('Adopted', 'Resolved') ORDER BY CASE urgency WHEN 'Critical' THEN 1 ELSE 2 END, created_at DESC LIMIT 3`);
    const stats = await get(`SELECT SUM(CASE WHEN status NOT IN ('Adopted','Resolved') THEN 1 ELSE 0 END) AS animals, SUM(CASE WHEN urgency = 'Critical' AND status NOT IN ('Adopted', 'Resolved') THEN 1 ELSE 0 END) AS urgent, SUM(CASE WHEN status = 'Adopted' THEN 1 ELSE 0 END) AS adopted FROM animals`);
    const animals = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id WHERE animals.status NOT IN ('Adopted','Resolved') ORDER BY CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, animals.created_at DESC LIMIT 10`);
    const featured = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id WHERE animals.species='Dog' AND animals.status NOT IN ('Adopted','Resolved') ORDER BY CASE animals.urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, animals.created_at DESC LIMIT 5`);
    const profiles = await all(`SELECT users.*, COUNT(animals.id) AS listing_count FROM users LEFT JOIN animals ON animals.user_id=users.id WHERE users.verification_status='Verified' GROUP BY users.id ORDER BY listing_count DESC, users.username LIMIT 6`);
    const stories = await all(`SELECT rescue_updates.*, animals.name AS animal_name, animals.photo_url FROM rescue_updates JOIN animals ON animals.id = rescue_updates.animal_id ORDER BY rescue_updates.created_at DESC LIMIT 3`);
    const happyStats = await get(`SELECT COUNT(DISTINCT animal_id) AS helped, COUNT(*) AS accepted_offers FROM applications WHERE status='Accepted'`);
    res.render('home', { title: 'PawPath | Rescue, foster and adopt responsibly', urgent, stats, happyStats, animals, featured, stories, profiles, mapAssets: true, exploreAssets: true });
  } catch (error) { next(error); }
});

app.get('/about', async (req, res, next) => {
  try {
    const galleryDogs = await all(`SELECT id,name,photo_url,locality,status FROM animals WHERE species='Dog' AND COALESCE(photo_url,'')<>'' ORDER BY CASE WHEN status NOT IN ('Adopted','Resolved') THEN 0 ELSE 1 END, created_at DESC LIMIT 10`);
    const aboutStats = await get(`SELECT COUNT(*) AS listings, SUM(CASE WHEN status IN ('Adopted','Resolved') THEN 1 ELSE 0 END) AS completed FROM animals`);
    res.render('about', { title: 'About Us | PawPath', galleryDogs, aboutStats, aboutAssets: true });
  } catch (error) { next(error); }
});

app.get('/happy-tails', async (req, res, next) => {
  try {
    const stories = await all(`SELECT happy_tails.*,users.username FROM happy_tails LEFT JOIN users ON users.id=happy_tails.user_id ORDER BY happy_tails.created_at DESC`);
    const adoptedAnimals = req.session.user ? await all(`SELECT DISTINCT animals.id,animals.name FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.user_id=? AND applications.status='Accepted' ORDER BY animals.name`, [req.session.user.id]) : [];
    const happyStats = await get(`SELECT COUNT(DISTINCT animal_id) AS helped, COUNT(*) AS accepted_offers FROM applications WHERE status='Accepted'`);
    const galleryAnimals = await all(`SELECT id,name,photo_url,locality FROM animals WHERE species='Dog' AND COALESCE(photo_url,'')<>'' ORDER BY CASE WHEN status NOT IN ('Adopted','Resolved') THEN 0 ELSE 1 END, created_at DESC LIMIT 8`);
    res.render('happy-tails', { title: 'Happy Tails | PawPath', stories, adoptedAnimals, happyStats, galleryAnimals, errors: [], happyTailsAssets: true });
  } catch (error) { next(error); }
});

app.post('/happy-tails', requireLogin, upload.single('after_photo'), async (req, res, next) => {
  try {
    const adopted = await get(`SELECT animals.id,animals.name,animals.photo_url FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.user_id=? AND applications.status='Accepted' AND animals.id=?`, [req.session.user.id, req.body.animal_id]);
    const errors = [];
    if (!adopted) errors.push('Choose an animal whose adoption offer was accepted.');
    if (String(req.body.title || '').trim().length < 5) errors.push('Add a short title for your happy tale.');
    if (String(req.body.story_text || '').trim().length < 40) errors.push('Tell us a little more about life after adoption.');
    if (errors.length) {
      const stories = await all(`SELECT happy_tails.*,users.username FROM happy_tails LEFT JOIN users ON users.id=happy_tails.user_id ORDER BY happy_tails.created_at DESC`);
      const adoptedAnimals = await all(`SELECT DISTINCT animals.id,animals.name FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.user_id=? AND applications.status='Accepted' ORDER BY animals.name`, [req.session.user.id]);
      const happyStats = await get(`SELECT COUNT(DISTINCT animal_id) AS helped, COUNT(*) AS accepted_offers FROM applications WHERE status='Accepted'`);
      const galleryAnimals = await all(`SELECT id,name,photo_url,locality FROM animals WHERE species='Dog' AND COALESCE(photo_url,'')<>'' ORDER BY CASE WHEN status NOT IN ('Adopted','Resolved') THEN 0 ELSE 1 END, created_at DESC LIMIT 8`);
      return res.status(400).render('happy-tails', { title: 'Happy Tails | PawPath', stories, adoptedAnimals, happyStats, galleryAnimals, errors, happyTailsAssets: true });
    }
    const photo = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : (adopted.photo_url || '');
    await run('INSERT INTO happy_tails (user_id,animal_id,dog_name,title,story_text,after_photo_url) VALUES (?,?,?,?,?,?)', [req.session.user.id, adopted.id, adopted.name, req.body.title.trim(), req.body.story_text.trim(), photo]);
    flash(req, 'success', `${adopted.name}'s happy tale is now part of the PawPath family.`); res.redirect('/happy-tails');
  } catch (error) { next(error); }
});

app.post('/happy-tails/:id/delete', requireLogin, async (req, res, next) => {
  try {
    const story = await get('SELECT id,user_id,dog_name FROM happy_tails WHERE id=?', [req.params.id]);
    if (!story) { flash(req, 'error', 'That Happy Tail no longer exists.'); return res.redirect('/happy-tails'); }
    if (Number(story.user_id) !== Number(req.session.user.id)) { flash(req, 'error', 'You can only delete a Happy Tail you shared.'); return res.redirect('/happy-tails'); }
    await run('DELETE FROM happy_tails WHERE id=? AND user_id=?', [story.id, req.session.user.id]);
    flash(req, 'success', `${story.dog_name}'s Happy Tail was deleted.`);
    res.redirect('/happy-tails');
  } catch (error) { next(error); }
});

// Focused discovery pages keep each help flow simple instead of crowding one screen.
app.get('/sos', async (req, res, next) => {
  try {
    const animals = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id WHERE animals.urgency IN ('Critical','Needs Help Today') AND animals.status NOT IN ('Adopted','Resolved') ORDER BY CASE animals.urgency WHEN 'Critical' THEN 1 ELSE 2 END, animals.created_at DESC`);
    res.render('sos', { title: 'Urgent SOS | PawPath', animals });
  } catch (error) { next(error); }
});
app.get('/foster', (req, res) => res.redirect('/animals?category=Urgent%20Foster%20Needed'));
app.get('/community', (req, res) => res.redirect('/animals?category=Community%20Feeder%20Spot'));

app.get('/map', (req, res) => res.render('map', { title: 'Live map | PawPath', mapAssets: true }));

app.get('/api/live', requireLogin, (req, res) => {
  const userId = Number(req.session.user.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: connected\ndata: {"ok":true}\n\n`);
  if (!liveClients.has(userId)) liveClients.set(userId, new Set());
  liveClients.get(userId).add(res);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); liveClients.get(userId)?.delete(res); if (!liveClients.get(userId)?.size) liveClients.delete(userId); });
});

app.get('/api/messages/:id/since', requireLogin, async (req, res, next) => {
  try {
    const conversation = await get('SELECT * FROM conversations WHERE id=?', [req.params.id]);
    if (!conversation || ![conversation.initiator_id, conversation.recipient_id].includes(req.session.user.id)) return res.status(403).json({ error: 'Not available' });
    const rows = await all(`SELECT messages.*,users.username FROM messages JOIN users ON users.id=messages.sender_id WHERE conversation_id=? AND messages.id>? ORDER BY messages.id`, [conversation.id, Number(req.query.after || 0)]);
    const readColumn = conversation.initiator_id === req.session.user.id ? 'initiator_read_at' : 'recipient_read_at';
    if (rows.length) await run(`UPDATE conversations SET ${readColumn}=CURRENT_TIMESTAMP WHERE id=?`, [conversation.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

async function nominatimRequest(url) {
  const cached = locationCache.get(url);
  if (cached && Date.now() - cached.savedAt < 1000 * 60 * 60 * 24) return cached.value;
  const wait = Math.max(0, 1050 - (Date.now() - lastGeocoderRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocoderRequestAt = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': 'PawPath-Student-Project/1.0', 'Accept-Language': 'en' } });
  if (!response.ok) throw new Error('Location service is temporarily unavailable.');
  const value = await response.json();
  locationCache.set(url, { savedAt: Date.now(), value });
  return value;
}
app.get('/api/location-search', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=in&limit=5&q=${encodeURIComponent(q)}`;
    const results = await nominatimRequest(url);
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(results.map((item) => ({ label: item.display_name, latitude: Number(item.lat), longitude: Number(item.lon) })));
  } catch (error) {
    const fallback = coordinatesForPlace(q, '', `search:${q}`);
    res.json([{ label: `${q} (approximate pin — use Detect my location for an exact pin)`, latitude: fallback.latitude, longitude: fallback.longitude, accuracy: 'approximate' }]);
  }
});
app.get('/api/location-reverse', async (req, res, next) => {
  const latitude = Number(req.query.lat ?? req.query.latitude); const longitude = Number(req.query.lon ?? req.query.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'Valid coordinates are required.' });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${latitude}&lon=${longitude}`;
    const result = await nominatimRequest(url);
    if (result.address?.country_code && result.address.country_code !== 'in') return res.status(400).json({ error: 'Please choose a location in India.' });
    res.json({ label: result.display_name || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`, latitude, longitude });
  } catch (error) { res.json({ label: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`, latitude, longitude, addressUnavailable: true }); }
});

app.get('/api/map-data', async (req, res, next) => {
  try {
    const animals = await all(`SELECT id,name,species,species_other,locality,urgency,category,status,photo_url,latitude,longitude,location_accuracy
      FROM animals WHERE status NOT IN ('Adopted','Resolved') ORDER BY created_at DESC`);
    const members = await all(`SELECT id,username AS name,entity_type AS category,locality AS location,verification_status,latitude,longitude,location_accuracy
      FROM users ORDER BY username`);
    const directory = await all(`SELECT id,name,category,subtype,city,state,address,trust_status,listing_readiness,latitude,longitude,location_accuracy
      FROM directory_entries ORDER BY category,name`);

    const listingPoints = animals.map((animal) => {
      const fallback = coordinatesForPlace(animal.locality, '', `animal:${animal.id}`);
      return {
        id: `listing-${animal.id}`, kind: 'listing', recordId: animal.id, name: animal.name,
        category: animal.category, subtype: animal.species === 'Other' && animal.species_other ? animal.species_other : animal.species, location: animal.locality,
        urgency: animal.urgency, status: animal.status, photo: animal.photo_url,
        latitude: Number(animal.latitude ?? fallback.latitude), longitude: Number(animal.longitude ?? fallback.longitude),
        locationAccuracy: animal.location_accuracy || fallback.location_accuracy, url: `/animals/${animal.id}`
      };
    });
    const memberPoints = members.map((member) => {
      const fallback = coordinatesForPlace(member.location, '', `member:${member.id}`);
      const group = member.category === 'Veterinarian / vet clinic' ? 'vets' : member.category === 'Shelter / NGO / rescue organisation' ? 'organisations' : 'volunteers';
      return {
        id: `member-${member.id}`, kind: 'network', recordId: member.id, name: member.name,
        category: group, subtype: member.category, location: member.location,
        trust: member.verification_status === 'Verified' ? 'PawPath verified' : member.verification_status === 'Under review' ? 'Verification under review' : 'Unverified member',
        latitude: Number(member.latitude ?? fallback.latitude), longitude: Number(member.longitude ?? fallback.longitude),
        locationAccuracy: member.location_accuracy || fallback.location_accuracy, url: `/profiles/${member.id}`
      };
    });
    const directoryPoints = directory.map((entry) => {
      const location = [entry.address, entry.city, entry.state].filter(Boolean).join(', ');
      const fallback = coordinatesForPlace([entry.address, entry.city].filter(Boolean).join(', '), entry.state, `directory:${entry.id}`);
      return {
        id: `directory-${entry.id}`, kind: 'network', recordId: entry.id, name: entry.name,
        category: entry.category, subtype: entry.subtype, location,
        trust: entry.listing_readiness === 'service_verified' ? 'Rescue services confirmed' : entry.trust_status === 'awbi_recognised' ? 'AWBI recognised' : entry.trust_status === 'source_verified' ? 'Source checked' : entry.trust_status === 'official_source' ? 'Official source' : 'Directory listing',
        latitude: Number(entry.latitude ?? fallback.latitude), longitude: Number(entry.longitude ?? fallback.longitude),
        locationAccuracy: entry.location_accuracy || fallback.location_accuracy, url: `/directory/${entry.id}`
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ generatedAt: new Date().toISOString(), points: [...listingPoints, ...memberPoints, ...directoryPoints] });
  } catch (error) { next(error); }
});

app.get('/profiles', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const trust = ['all', 'pawpath', 'source_checked', 'awbi', 'service_verified'].includes(req.query.trust) ? req.query.trust : 'all';
    const state = String(req.query.state || '').trim();
    const group = networkGroups[req.query.group] ? req.query.group : '';
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const clauses = [];
    const params = [];
    if (req.session.user) { clauses.push("NOT (source_type='user' AND record_id=?)"); params.push(String(req.session.user.id)); }
    if (group) { clauses.push('category=?'); params.push(group); }
    if (state) { clauses.push('state=?'); params.push(state); }
    if (q) {
      const search = `%${q.toLowerCase()}%`;
      clauses.push('(LOWER(name) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ? OR LOWER(awbi_code) LIKE ?)');
      params.push(search, search, search, search);
    }
    if (trust === 'pawpath') clauses.push("source_type='user' AND trust_status='Verified'");
    if (trust === 'source_checked') clauses.push("source_type='directory' AND trust_status IN ('source_verified','official_source')");
    if (trust === 'awbi') clauses.push("source_type='directory' AND trust_status='awbi_recognised'");
    if (trust === 'service_verified') clauses.push("source_type='directory' AND listing_readiness='service_verified'");
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = await get(`${networkDirectoryCte} SELECT COUNT(*) AS count FROM network ${where}`, params);
    const total = Number(count.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / NETWORK_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const profiles = await all(`${networkDirectoryCte}
      SELECT * FROM network ${where}
      ORDER BY CASE source_type WHEN 'user' THEN 1 ELSE 2 END,
        CASE trust_status WHEN 'Verified' THEN 1 WHEN 'source_verified' THEN 2 WHEN 'official_source' THEN 3 WHEN 'awbi_recognised' THEN 4 ELSE 5 END,
        name
      LIMIT ? OFFSET ?`, [...params, NETWORK_PAGE_SIZE, (page - 1) * NETWORK_PAGE_SIZE]);
    const states = await all("SELECT DISTINCT state FROM directory_entries WHERE COALESCE(state,'')!='' ORDER BY state");
    const groupCounts = await all(`${networkDirectoryCte} SELECT category, COUNT(*) AS count FROM network GROUP BY category`);
    const counts = Object.fromEntries(groupCounts.map((item) => [item.category, Number(item.count)]));
    const pageUrl = (number) => {
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (group) query.set('group', group);
      if (state) query.set('state', state);
      if (trust !== 'all') query.set('trust', trust);
      if (number > 1) query.set('page', String(number));
      return `/profiles${query.toString() ? `?${query}` : ''}`;
    };
    res.render('profiles', { title: 'Network | PawPath', profiles, filters: { q, trust, state, group }, networkGroups, states, counts, total, page, totalPages, pageUrl });
  } catch (error) { next(error); }
});

app.get('/directory/:id', async (req, res, next) => {
  try {
    const entry = await get('SELECT * FROM directory_entries WHERE id=?', [req.params.id]);
    if (!entry) return res.status(404).render('error', { title: 'Directory record not found | PawPath', message: 'That network record does not exist.' });
    entry.source_url = safeWebsite(entry.source_url);
    entry.website = safeWebsite(entry.website);
    const complaintRisk = await get("SELECT COUNT(DISTINCT reporter_user_id) AS reporters FROM complaints WHERE target_directory_id=? AND status IN ('Submitted','Under review','Substantiated')", [entry.id]);
    res.render('directory-detail', { title: `${entry.name} | PawPath`, entry, complaintReporters: Number(complaintRisk?.reporters || 0) });
  } catch (error) { next(error); }
});

app.get('/profiles/:id', async (req, res, next) => {
  try {
    const profile = await get('SELECT id, username, role, bio, locality, profile_photo, verification_status, verified_at, created_at, entity_type, organisation_name, phone, show_phone, public_email, show_public_email, instagram_handle, show_instagram, website, show_website FROM users WHERE id=?', [req.params.id]);
    if (!profile) return res.status(404).render('error', { title: 'Profile not found | PawPath', message: 'That community profile does not exist.' });
    if (req.session.user && profile.id === req.session.user.id) return res.redirect('/dashboard');
    const listings = await all("SELECT * FROM animals WHERE user_id=? ORDER BY CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, created_at DESC", [profile.id]);
    const ownListings = req.session.user ? await all("SELECT * FROM animals WHERE user_id=? AND status NOT IN ('Adopted','Resolved') ORDER BY created_at DESC", [req.session.user.id]) : [];
    const listingMatches = ownListings.map((listing) => ({ id: listing.id, score: listingMatchScore(listing, profile) }));
    const complaintRisk = await get("SELECT COUNT(DISTINCT reporter_user_id) AS reporters FROM complaints WHERE target_user_id=? AND status IN ('Submitted','Under review','Substantiated')", [profile.id]);
    res.render('profile-detail', { title: `${profile.username} | PawPath`, profile, listings, ownListings, listingMatches, complaintReporters: Number(complaintRisk?.reporters || 0) });
  } catch (error) { next(error); }
});

app.post('/profiles/:id/chat', requireLogin, async (req, res, next) => {
  try {
    const recipient = await get('SELECT id, username, role, verification_status FROM users WHERE id=?', [req.params.id]);
    if (!recipient || recipient.id === req.session.user.id) {
      flash(req, 'error', 'Choose another PawPath member to message.');
      return res.redirect(`/profiles/${req.params.id}`);
    }
    let listing = null;
    if (req.body.listing_id) {
      listing = await get("SELECT * FROM animals WHERE id=? AND user_id=? AND status NOT IN ('Adopted','Resolved')", [req.body.listing_id, req.session.user.id]);
      if (!listing) { flash(req, 'error', 'Please choose one of your active listings.'); return res.redirect(`/profiles/${req.params.id}`); }
      if (String(req.body.message || '').trim().length < 12) { flash(req, 'error', 'Please briefly explain why this animal could be a good fit.'); return res.redirect(`/profiles/${req.params.id}#contact`); }
    }
    const score = listing ? listingMatchScore(listing, recipient) : 0;
    const topic = listing ? `About ${listing.name}` : 'Direct message';
    let conversation = listing
      ? await get('SELECT id FROM conversations WHERE listing_id=? AND ((initiator_id=? AND recipient_id=?) OR (initiator_id=? AND recipient_id=?))', [listing.id, req.session.user.id, recipient.id, recipient.id, req.session.user.id])
      : await get('SELECT id FROM conversations WHERE listing_id IS NULL AND ((initiator_id=? AND recipient_id=?) OR (initiator_id=? AND recipient_id=?))', [req.session.user.id, recipient.id, recipient.id, req.session.user.id]);
    let createdNow = false;
    if (!conversation) {
      const created = await run('INSERT INTO conversations (listing_id,initiator_id,recipient_id,compatibility_score,topic) VALUES (?,?,?,?,?)', [listing ? listing.id : null, req.session.user.id, recipient.id, score, topic]);
      conversation = { id: created.id };
      createdNow = true;
    }
    const writtenMessage = String(req.body.message || '').trim();
    const firstMessage = writtenMessage || (listing
      ? `Hi ${recipient.username}, I think ${listing.name} could be a good match for your support. Would you be open to discussing this listing?`
      : `Hi ${recipient.username}, I would like to connect with you on PawPath.`);
    if (createdNow || writtenMessage) {
      const message = await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, firstMessage]);
      await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [conversation.id]);
      await createNotification(recipient.id, `message-${message.id}`, 'message', `New message from ${req.session.user.username}`, firstMessage.slice(0, 120), `/messages/${conversation.id}`);
      pushLive(recipient.id, 'message', { conversationId: conversation.id, messageId: message.id, sender: req.session.user.username, body: firstMessage });
    }
    flash(req, 'success', listing ? `Conversation started. Compatibility: ${score}%.` : 'Conversation started.');
    res.redirect(`/messages/${conversation.id}`);
  } catch (error) { next(error); }
});

app.post('/profiles/:id/approach', requireLogin, (req, res) => res.redirect(307, `/profiles/${req.params.id}/chat`));

app.get('/messages', requireLogin, async (req, res, next) => {
  try {
    const rows = await all(`SELECT conversations.*, COALESCE(conversations.topic, animals.name, 'Direct message') AS topic,
      animals.name AS listing_name, animals.photo_url AS listing_photo,
      CASE WHEN conversations.initiator_id=? THEN recipients.username ELSE initiators.username END AS other_username,
      CASE WHEN conversations.initiator_id=? THEN recipients.profile_photo ELSE initiators.profile_photo END AS other_photo
      FROM conversations
      LEFT JOIN animals ON animals.id=conversations.listing_id
      JOIN users AS initiators ON initiators.id=conversations.initiator_id
      JOIN users AS recipients ON recipients.id=conversations.recipient_id
      WHERE conversations.initiator_id=? OR conversations.recipient_id=?
      ORDER BY conversations.updated_at DESC`, [req.session.user.id, req.session.user.id, req.session.user.id, req.session.user.id]);
    const conversations = await Promise.all(rows.map(async (conversation) => {
      const lastMessage = await get('SELECT body,created_at,sender_id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversation.id]);
      const readAt = conversation.initiator_id === req.session.user.id ? conversation.initiator_read_at : conversation.recipient_read_at;
      const unread = await get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND sender_id<>? AND created_at>COALESCE(?, '1970-01-01')", [conversation.id, req.session.user.id, readAt]);
      return { ...conversation, last_message: lastMessage?.body || 'Conversation started', last_message_at: lastMessage?.created_at || conversation.created_at, unread_count: Number(unread?.count || 0) };
    }));
    res.render('messages', { title: 'Messages | PawPath', conversations });
  } catch (error) { next(error); }
});

app.get('/messages/:id', requireLogin, async (req, res, next) => {
  try {
    const conversation = await get(`SELECT conversations.*, COALESCE(conversations.topic, animals.name, 'Direct message') AS topic,
      animals.name AS listing_name, animals.photo_url AS listing_photo, animals.user_id AS listing_owner_id,
      initiators.username AS initiator_name, recipients.username AS recipient_name
      FROM conversations LEFT JOIN animals ON animals.id=conversations.listing_id
      JOIN users AS initiators ON initiators.id=conversations.initiator_id
      JOIN users AS recipients ON recipients.id=conversations.recipient_id
      WHERE conversations.id=?`, [req.params.id]);
    if (!conversation || (conversation.initiator_id !== req.session.user.id && conversation.recipient_id !== req.session.user.id)) {
      flash(req, 'error', 'That conversation is not available to you.'); return res.redirect('/messages');
    }
    const readColumn = conversation.initiator_id === req.session.user.id ? 'initiator_read_at' : 'recipient_read_at';
    await run(`UPDATE conversations SET ${readColumn}=CURRENT_TIMESTAMP WHERE id=?`, [conversation.id]);
    const messages = await all(`SELECT messages.*, users.username FROM messages JOIN users ON users.id=messages.sender_id WHERE conversation_id=? ORDER BY messages.created_at ASC, messages.id ASC`, [conversation.id]);
    const otherId = conversation.initiator_id === req.session.user.id ? conversation.recipient_id : conversation.initiator_id;
    const other = await get('SELECT id,username,profile_photo,verification_status,entity_type,locality,phone,show_phone,public_email,show_public_email FROM users WHERE id=?', [otherId]);
    const offer = conversation.listing_id ? await get('SELECT * FROM applications WHERE animal_id=? AND user_id IN (?,?) ORDER BY created_at DESC LIMIT 1', [conversation.listing_id, req.session.user.id, otherId]) : null;
    res.render('conversation', { title: `Chat with ${other.username} | PawPath`, conversation, messages, otherName: other.username, other, offer, errors: [] });
  } catch (error) { next(error); }
});

app.post('/messages/:id', requireLogin, async (req, res, next) => {
  try {
    const conversation = await get('SELECT * FROM conversations WHERE id=?', [req.params.id]);
    if (!conversation || (conversation.initiator_id !== req.session.user.id && conversation.recipient_id !== req.session.user.id)) return res.redirect('/messages');
    const body = String(req.body.body || '').trim();
    if (!body || body.length > 1500) { flash(req, 'error', 'Write a message between 1 and 1,500 characters.'); return res.redirect(`/messages/${conversation.id}`); }
    const message = await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, body]);
    await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [conversation.id]);
    const recipientId = conversation.initiator_id === req.session.user.id ? conversation.recipient_id : conversation.initiator_id;
    await createNotification(recipientId, `message-${message.id}`, 'message', `New message from ${req.session.user.username}`, body.slice(0, 120), `/messages/${conversation.id}`);
    pushLive(recipientId, 'message', { conversationId: conversation.id, messageId: message.id, sender: req.session.user.username, body });
    if (req.get('accept')?.includes('application/json')) return res.json({ id: message.id, conversationId: conversation.id, sender_id: req.session.user.id, username: req.session.user.username, body, created_at: new Date().toISOString() });
    res.redirect(`/messages/${conversation.id}`);
  } catch (error) { next(error); }
});

app.get('/animals', async (req, res, next) => {
  try {
    const filters = { q: req.query.q || '', species: req.query.species || '', category: req.query.category || '', urgency: req.query.urgency || '', status: req.query.status || '', vaccinated: req.query.vaccinated || '', sort: req.query.sort || 'newest' };
    const clauses = [];
    const params = [];
    if (filters.q) { clauses.push('(name LIKE ? OR locality LIKE ? OR description LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
    ['species', 'category', 'urgency', 'status', 'vaccinated'].forEach((key) => { if (filters[key]) { clauses.push(`${key} = ?`); params.push(filters[key]); } });
    const ownLast = req.session.user ? `CASE WHEN animals.user_id = ${Number(req.session.user.id)} THEN 1 ELSE 0 END,` : '';
    const acceptedLast = `CASE WHEN animals.status IN ('Adopted','Resolved') THEN 1 ELSE 0 END,`;
    const order = filters.sort === 'urgency' ? `${acceptedLast} ${ownLast} CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, animals.created_at DESC` : `${acceptedLast} ${ownLast} animals.created_at DESC`;
    const animals = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order}`, params);
    const activeAnimals = animals.filter((animal) => !['Adopted','Resolved'].includes(animal.status));
    const completedAnimals = animals.filter((animal) => ['Adopted','Resolved'].includes(animal.status));
    res.render('animals', { title: 'Explore Animals | PawPath', animals, activeAnimals, completedAnimals, filters });
  } catch (error) { next(error); }
});

app.get('/animals/new', requireLogin, (req, res) => {
  const animal = req.query.sos === '1' ? { category: 'Medical / Rescue SOS', urgency: 'Critical', status: 'Reported' } : {};
  res.render('animal-form', { title: 'Report a Stray | PawPath', animal, action: '/animals', formTitle: req.query.sos === '1' ? 'Post an urgent SOS' : 'Create an animal profile', errors: [] });
});
app.post('/animals', requireLogin, upload.single('photo'), async (req, res, next) => {
  const errors = validateAnimal(req.body);
  const uploadedPhoto = photoFromRequest(req);
  if (errors.length) return res.status(400).render('animal-form', { title: 'Fix listing details | PawPath', animal: { ...req.body, photo_url: uploadedPhoto }, action: '/animals', formTitle: 'Create an animal profile', errors });
  try {
    const b = req.body;
    const result = await run(`INSERT INTO animals (user_id,name,species,species_other,gender,age,size,colour,temperament,vaccinated,vaccinations_done,vaccinations_required,sterilised,medical_notes,locality,location_status,urgency,category,status,photo_url,description,contact_details,latitude,longitude,location_accuracy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.session.user.id, ...listingValues(b, uploadedPhoto)]);
    flash(req, 'success', 'Animal profile created—thank you for taking action.');
    res.redirect(`/animals/${result.id}`);
  } catch (error) { next(error); }
});

app.get('/animals/:id', async (req, res, next) => {
  try {
    const animal = await get('SELECT animals.*, users.username, users.verification_status, users.role FROM animals JOIN users ON users.id = animals.user_id WHERE animals.id = ?', [req.params.id]);
    if (!animal) return res.status(404).render('error', { title: 'Not found | PawPath', message: 'That animal profile no longer exists.' });
    const updates = await all('SELECT rescue_updates.*, users.username FROM rescue_updates JOIN users ON users.id = rescue_updates.user_id WHERE animal_id = ? ORDER BY created_at DESC', [animal.id]);
    const acceptedOffer = await get("SELECT * FROM applications WHERE animal_id=? AND status='Accepted' ORDER BY updated_at DESC LIMIT 1", [animal.id]);
    const canPostUpdate = Boolean(req.session.user && (req.session.user.id === animal.user_id || acceptedOffer?.user_id === req.session.user.id));
    res.render('animal-detail', { title: `${animal.name} | PawPath`, animal, updates, applicationErrors: [], application: {}, acceptedOffer, canPostUpdate });
  } catch (error) { next(error); }
});

app.get('/animals/:id/edit', requireLogin, async (req, res, next) => {
  try {
    const animal = await get('SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id WHERE animals.id = ?', [req.params.id]);
    if (!animal || animal.user_id !== req.session.user.id) { flash(req, 'error', 'You can only edit your own listings.'); return res.redirect('/dashboard'); }
    res.render('animal-form', { title: `Edit ${animal.name} | PawPath`, animal, action: `/animals/${animal.id}/edit`, formTitle: `Edit ${animal.name}'s profile`, errors: [] });
  } catch (error) { next(error); }
});
app.post('/animals/:id/edit', requireLogin, upload.single('photo'), async (req, res, next) => {
  const errors = validateAnimal(req.body);
  const existing = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
  if (!existing || existing.user_id !== req.session.user.id) { flash(req, 'error', 'You can only edit your own listings.'); return res.redirect('/dashboard'); }
  const uploadedPhoto = photoFromRequest(req, existing.photo_url);
  if (errors.length) return res.status(400).render('animal-form', { title: 'Fix listing details | PawPath', animal: { ...existing, ...req.body, id: req.params.id, photo_url: uploadedPhoto }, action: `/animals/${req.params.id}/edit`, formTitle: `Edit ${existing.name}'s profile`, errors });
  try {
    const b = req.body;
    await run(`UPDATE animals SET name=?,species=?,species_other=?,gender=?,age=?,size=?,colour=?,temperament=?,vaccinated=?,vaccinations_done=?,vaccinations_required=?,sterilised=?,medical_notes=?,locality=?,location_status=?,urgency=?,category=?,status=?,photo_url=?,description=?,contact_details=?,latitude=?,longitude=?,location_accuracy=? WHERE id=?`, [...listingValues(b, uploadedPhoto), existing.id]);
    flash(req, 'success', 'Animal profile updated.'); res.redirect(`/animals/${existing.id}`);
  } catch (error) { next(error); }
});
app.post('/animals/:id/delete', requireLogin, async (req, res, next) => {
  try {
    const animal = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
    if (!animal || animal.user_id !== req.session.user.id) { flash(req, 'error', 'You can only delete your own listings.'); return res.redirect('/dashboard'); }
    await run('DELETE FROM animals WHERE id = ?', [animal.id]);
    flash(req, 'success', 'Listing deleted.'); res.redirect('/dashboard');
  } catch (error) { next(error); }
});

app.post('/animals/:id/apply', requireLogin, proofUpload.single('support_document'), async (req, res, next) => {
  try {
    const animal = await get('SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id WHERE animals.id = ?', [req.params.id]);
    if (!animal) return res.redirect('/animals');
    if (['Adopted', 'Resolved'].includes(animal.status)) { flash(req, 'error', 'This listing is complete because an offer has already been accepted.'); return res.redirect(`/animals/${animal.id}`); }
    const b = req.body;
    const errors = [];
    ['request_type', 'housing_type', 'locality', 'pet_experience', 'working_hours', 'contact_number'].forEach((field) => { if (!String(b[field] || '').trim()) errors.push(`${field.replace('_', ' ')} is required.`); });
    if (!/^\d{10}$/.test(String(b.contact_number || '').replace(/\s/g, ''))) errors.push('Enter a valid 10-digit contact number.');
    const updates = await all('SELECT rescue_updates.*, users.username FROM rescue_updates JOIN users ON users.id = rescue_updates.user_id WHERE animal_id = ? ORDER BY created_at DESC', [animal.id]);
    if (errors.length) return res.status(400).render('animal-detail', { title: `${animal.name} | PawPath`, animal, updates, applicationErrors: errors, application: b });
    const document = proofFromRequest(req);
    const result = await run(`INSERT INTO applications (animal_id,user_id,request_type,housing_type,locality,pet_experience,working_hours,contact_number,message,compatibility_score,share_contact,share_profile,share_verification,support_document,support_document_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [animal.id, req.session.user.id, b.request_type, b.housing_type, b.locality.trim(), b.pet_experience, b.working_hours, b.contact_number.replace(/\s/g, ''), String(b.message || '').trim(), compatibility(b), b.share_contact === 'on' ? 1 : 0, b.share_profile === 'on' ? 1 : 0, b.share_verification === 'on' ? 1 : 0, document, req.file?.originalname || '']);
    await run('INSERT INTO rescue_updates (animal_id,user_id,update_text,update_type,is_automatic) VALUES (?,?,?,?,1)', [animal.id, req.session.user.id, `${req.session.user.username} sent a ${b.request_type.toLowerCase()} offer.`, 'Offer received']);
    await createNotification(animal.user_id, `offer-${result.id}`, 'offer', `New ${b.request_type} offer for ${animal.name}`, `${req.session.user.username} sent a help offer. Review their message, contact details and shared documents.`, `/offers/${result.id}`);
    pushLive(animal.user_id, 'offer', { offerId: result.id, animalId: animal.id, title: `New ${b.request_type} offer for ${animal.name}`, body: `${req.session.user.username} sent a help offer.` });
    flash(req, 'success', 'Your help offer has been sent. You can track it from My Dashboard.'); res.redirect(`/offers/${result.id}`);
  } catch (error) { next(error); }
});

app.get('/offers/:id', requireLogin, async (req, res, next) => {
  try {
    const offer = await get(`SELECT applications.*, animals.name AS animal_name, animals.photo_url AS animal_photo, animals.user_id AS listing_owner_id,
      applicants.username AS applicant_name, applicants.email AS applicant_email, applicants.profile_photo AS applicant_photo,
      applicants.verification_status, applicants.entity_type, applicants.bio AS applicant_bio, applicants.locality AS applicant_locality,
      owners.username AS owner_name, owners.phone AS owner_phone, owners.show_phone AS owner_show_phone,
      owners.public_email AS owner_public_email, owners.show_public_email AS owner_show_public_email
      FROM applications JOIN animals ON animals.id=applications.animal_id
      JOIN users AS applicants ON applicants.id=applications.user_id JOIN users AS owners ON owners.id=animals.user_id
      WHERE applications.id=?`, [req.params.id]);
    if (!offer || (offer.user_id !== req.session.user.id && offer.listing_owner_id !== req.session.user.id && !req.session.user.is_admin)) {
      flash(req, 'error', 'That offer is not available to you.'); return res.redirect('/dashboard');
    }
    await run('UPDATE notifications SET is_read=1 WHERE user_id=? AND url=?', [req.session.user.id, `/offers/${offer.id}`]);
    const verification = offer.share_verification || offer.user_id === req.session.user.id || req.session.user.is_admin
      ? await get('SELECT applicant_type,government_id_type,government_id_reference,veterinarian_name,veterinarian_clinic,veterinarian_contact,residence_proof_reference,pet_experience,status,proof_document FROM verification_applications WHERE user_id=?', [offer.user_id])
      : null;
    if (verification) verification.masked_government_id = maskedReference(verification.government_id_reference);
    res.render('offer-detail', { title: `Offer for ${offer.animal_name} | PawPath`, offer, verification, canManage: offer.listing_owner_id === req.session.user.id });
  } catch (error) { next(error); }
});

app.post('/offers/:id/status', requireLogin, async (req, res, next) => {
  try {
    const offer = await get(`SELECT applications.*, animals.name AS animal_name, animals.user_id AS listing_owner_id FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.id=?`, [req.params.id]);
    if (!offer || offer.listing_owner_id !== req.session.user.id) return res.redirect('/dashboard');
    const statuses = { accept: 'Accepted', decline: 'Declined', request: 'More information needed' };
    const status = statuses[req.body.decision];
    if (!status) return res.redirect(`/offers/${offer.id}`);
    if (offer.status === 'Accepted') { flash(req, 'error', 'This offer is already accepted. The next step is to contact the adopter or request an update.'); return res.redirect(`/offers/${offer.id}`); }
    const applicant = await get('SELECT username,verification_status FROM users WHERE id=?', [offer.user_id]);
    if (status === 'Accepted' && applicant?.verification_status !== 'Verified' && String(req.body.unverified_confirmation || '').trim().toUpperCase() !== 'ACCEPT') {
      flash(req, 'error', 'This person is not verified or supported by a vet. Type ACCEPT in the warning box to confirm you still want to proceed.');
      return res.redirect(`/offers/${offer.id}`);
    }
    const ownerNote = String(req.body.owner_note || '').trim();
    await run('UPDATE applications SET status=?,owner_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, ownerNote, offer.id]);
    if (status === 'Accepted') {
      await run("UPDATE animals SET status='Adopted' WHERE id=?", [offer.animal_id]);
      await run("UPDATE applications SET status='Declined',owner_note='Another offer was accepted.',updated_at=CURRENT_TIMESTAMP WHERE animal_id=? AND id<>? AND status IN ('Pending','More information needed')", [offer.animal_id, offer.id]);
      await run('INSERT INTO rescue_updates (animal_id,user_id,update_text,update_type,is_automatic) VALUES (?,?,?,?,1)', [offer.animal_id, req.session.user.id, `${applicant.username}'s offer was accepted. This listing has moved to the completed section.`, 'Offer accepted']);
    } else {
      await run('INSERT INTO rescue_updates (animal_id,user_id,update_text,update_type,is_automatic) VALUES (?,?,?,?,1)', [offer.animal_id, req.session.user.id, `Offer status changed to ${status.toLowerCase()}.`, 'Offer update']);
    }
    await createNotification(offer.user_id, `offer-status-${offer.id}-${Date.now()}`, 'offer_update', `${offer.animal_name}: offer ${status.toLowerCase()}`, ownerNote || `The listing owner marked your offer as ${status.toLowerCase()}.`, `/offers/${offer.id}`);
    pushLive(offer.user_id, 'offer_update', { offerId: offer.id, animalId: offer.animal_id, status, title: `${offer.animal_name}: offer ${status.toLowerCase()}` });
    flash(req, 'success', `Offer marked ${status.toLowerCase()}.`); res.redirect(`/offers/${offer.id}`);
  } catch (error) { next(error); }
});

app.post('/offers/:id/chat', requireLogin, async (req, res, next) => {
  try {
    const offer = await get(`SELECT applications.*, animals.name AS animal_name, animals.user_id AS listing_owner_id FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.id=?`, [req.params.id]);
    if (!offer || (offer.user_id !== req.session.user.id && offer.listing_owner_id !== req.session.user.id)) return res.redirect('/dashboard');
    const otherId = offer.user_id === req.session.user.id ? offer.listing_owner_id : offer.user_id;
    let conversation = await get('SELECT id FROM conversations WHERE listing_id=? AND ((initiator_id=? AND recipient_id=?) OR (initiator_id=? AND recipient_id=?))', [offer.animal_id, req.session.user.id, otherId, otherId, req.session.user.id]);
    if (!conversation) {
      const created = await run('INSERT INTO conversations (listing_id,initiator_id,recipient_id,compatibility_score,topic) VALUES (?,?,?,?,?)', [offer.animal_id, req.session.user.id, otherId, offer.compatibility_score, `Offer for ${offer.animal_name}`]);
      conversation = { id: created.id };
    }
    const body = String(req.body.message || '').trim() || `Hi, I would like to discuss the ${offer.request_type.toLowerCase()} offer for ${offer.animal_name}.`;
    const message = await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, body]);
    await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [conversation.id]);
    await createNotification(otherId, `message-${message.id}`, 'message', `New message from ${req.session.user.username}`, body.slice(0, 120), `/messages/${conversation.id}`);
    pushLive(otherId, 'message', { conversationId: conversation.id, messageId: message.id, sender: req.session.user.username, body });
    res.redirect(`/messages/${conversation.id}`);
  } catch (error) { next(error); }
});

app.post('/offers/:id/request-update', requireLogin, async (req, res, next) => {
  try {
    const offer = await get(`SELECT applications.*,animals.name AS animal_name,animals.user_id AS listing_owner_id FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.id=?`, [req.params.id]);
    if (!offer || offer.listing_owner_id !== req.session.user.id || offer.status !== 'Accepted') { flash(req, 'error', 'An update can only be requested from the accepted adopter.'); return res.redirect('/dashboard'); }
    let conversation = await get('SELECT id FROM conversations WHERE listing_id=? AND ((initiator_id=? AND recipient_id=?) OR (initiator_id=? AND recipient_id=?))', [offer.animal_id, offer.listing_owner_id, offer.user_id, offer.user_id, offer.listing_owner_id]);
    if (!conversation) {
      const created = await run('INSERT INTO conversations (listing_id,initiator_id,recipient_id,compatibility_score,topic) VALUES (?,?,?,?,?)', [offer.animal_id, offer.listing_owner_id, offer.user_id, offer.compatibility_score, `After-adoption updates for ${offer.animal_name}`]);
      conversation = { id: created.id };
    }
    const body = `Hi! Could you please share an update about ${offer.animal_name}? You can reply here or post a text/photo update on the listing’s Rescue Journey.`;
    const message = await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, body]);
    await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [conversation.id]);
    await createNotification(offer.user_id, `update-request-${offer.id}-${message.id}`, 'message', `Update requested for ${offer.animal_name}`, `${req.session.user.username} requested an after-adoption update.`, `/messages/${conversation.id}`);
    pushLive(offer.user_id, 'message', { conversationId: conversation.id, messageId: message.id, sender: req.session.user.username, body });
    flash(req, 'success', `A live update request was sent to ${offer.animal_name}'s adopter.`); res.redirect(`/messages/${conversation.id}`);
  } catch (error) { next(error); }
});

app.get('/notifications', requireLogin, async (req, res, next) => {
  try {
    const notifications = await all('SELECT * FROM notifications WHERE user_id=? AND dismissed_at IS NULL ORDER BY created_at DESC', [req.session.user.id]);
    res.render('notifications', { title: 'Notifications | PawPath', notifications });
  } catch (error) { next(error); }
});
app.get('/notifications/:id/open', requireLogin, async (req, res, next) => {
  try {
    const notification = await get('SELECT * FROM notifications WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
    if (!notification) return res.redirect('/notifications');
    await run('UPDATE notifications SET is_read=1,dismissed_at=? WHERE id=?', [new Date().toISOString(), notification.id]);
    res.redirect(notification.url);
  } catch (error) { next(error); }
});
app.post('/notifications/:id/dismiss', requireLogin, async (req, res, next) => {
  try {
    await run('UPDATE notifications SET dismissed_at=CURRENT_TIMESTAMP,is_read=1 WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
    res.redirect(req.get('referer') || '/notifications');
  } catch (error) { next(error); }
});

app.post('/animals/:id/updates', requireLogin, upload.single('update_photo'), async (req, res, next) => {
  try {
    const animal = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
    const accepted = animal ? await get("SELECT user_id FROM applications WHERE animal_id=? AND status='Accepted' ORDER BY updated_at DESC LIMIT 1", [animal.id]) : null;
    if (!animal || (animal.user_id !== req.session.user.id && accepted?.user_id !== req.session.user.id)) { flash(req, 'error', 'Updates can be posted by the listing creator and the person whose offer was accepted.'); return res.redirect(`/animals/${req.params.id}`); }
    const text = String(req.body.update_text || '').trim();
    if (text.length < 8 && !req.file) { flash(req, 'error', 'Add a short note or a photo to post an update.'); return res.redirect(`/animals/${animal.id}`); }
    const photo = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : '';
    await run('INSERT INTO rescue_updates (animal_id,user_id,update_text,update_type,photo_url) VALUES (?,?,?,?,?)', [animal.id, req.session.user.id, text || 'Photo update', req.body.update_type || 'Progress update', photo]);
    flash(req, 'success', 'Rescue update posted.'); res.redirect(`/animals/${animal.id}`);
  } catch (error) { next(error); }
});
app.post('/updates/:id/delete', requireLogin, async (req, res, next) => {
  try {
    const update = await get('SELECT * FROM rescue_updates WHERE id = ?', [req.params.id]);
    if (!update || update.user_id !== req.session.user.id) { flash(req, 'error', 'You can only delete your own updates.'); return res.redirect('/dashboard'); }
    await run('DELETE FROM rescue_updates WHERE id = ?', [update.id]);
    flash(req, 'success', 'Update deleted.'); res.redirect(`/animals/${update.animal_id}`);
  } catch (error) { next(error); }
});

app.get('/dashboard', requireLogin, async (req, res, next) => {
  try {
    const listings = await all("SELECT * FROM animals WHERE user_id = ? ORDER BY CASE WHEN status IN ('Adopted','Resolved') THEN 1 ELSE 0 END, created_at DESC", [req.session.user.id]);
    const received = await all(`SELECT applications.*, animals.name AS animal_name, animals.photo_url AS animal_photo, users.username AS applicant_name, users.verification_status AS applicant_verification FROM applications JOIN animals ON animals.id=applications.animal_id JOIN users ON users.id=applications.user_id WHERE animals.user_id=? ORDER BY applications.created_at DESC`, [req.session.user.id]);
    const sent = await all(`SELECT applications.*, animals.name AS animal_name, animals.photo_url AS animal_photo, owners.username AS owner_name FROM applications JOIN animals ON animals.id=applications.animal_id JOIN users AS owners ON owners.id=animals.user_id WHERE applications.user_id=? ORDER BY applications.created_at DESC`, [req.session.user.id]);
    for (const offer of received) await createNotification(req.session.user.id, `offer-${offer.id}`, 'offer', `Offer for ${offer.animal_name}`, `${offer.applicant_name} offered ${offer.request_type.toLowerCase()}.`, `/offers/${offer.id}`);
    const profile = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    const verification = await get(`SELECT verification_applications.*,reviewing_vet.username AS reviewing_vet_name,reviewing_vet.organisation_name AS reviewing_vet_clinic FROM verification_applications LEFT JOIN users AS reviewing_vet ON reviewing_vet.id=verification_applications.selected_vet_user_id WHERE verification_applications.user_id=?`, [req.session.user.id]);
    res.render('dashboard', { title: 'My Dashboard | PawPath', listings, received, sent, profile, verification });
  } catch (error) { next(error); }
});

app.get('/signup', (req, res) => res.render('signup', { title: 'Join PawPath', errors: [], values: {} }));
app.post('/signup', proofUpload.single('verification_document'), async (req, res, next) => {
  const { username, email, password, confirm_password, captcha_answer, role, locality, entity_type, organisation_name, phone, public_email, instagram_handle, website, vet_registration_number, vet_council_name } = req.body;
  const errors = [];
  if (String(username || '').trim().length < 3) errors.push('Username must have at least 3 characters.');
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) errors.push('Enter a valid email address.');
  if (String(password || '').length < 8) errors.push('Password must have at least 8 characters.');
  if (password !== confirm_password) errors.push('Passwords do not match.');
  if (!Object.values(networkGroups).flatMap((group) => group.values).includes(entity_type)) errors.push('Please choose how you will participate in the PawPath network.');
  if (!String(locality || '').trim()) errors.push('Choose your location so your profile can appear on the PawPath map.');
  if (phone && !/^\d{10}$/.test(String(phone).replace(/\s/g, ''))) errors.push('Enter a valid 10-digit phone number, or leave it blank.');
  if (public_email && !/^\S+@\S+\.\S+$/.test(String(public_email))) errors.push('Enter a valid public email address, or leave it blank.');
  if (website && !safeWebsite(website)) errors.push('Enter a valid website address, or leave it blank.');
  if (entity_type === 'Veterinarian / vet clinic') {
    if (!String(vet_registration_number || '').trim()) errors.push('Veterinary registration number is required for veterinarian accounts.');
    if (!String(vet_council_name || '').trim()) errors.push('Choose or enter the veterinary council that issued your registration.');
    if (!req.file) errors.push('Upload your veterinary registration certificate or professional ID to register as a veterinarian.');
  }
  if (!captchaOk(req, captcha_answer, req.body.captcha_token)) errors.push('CAPTCHA answer was incorrect. Please try the new question.');
  if (errors.length) return res.status(400).render('signup', { title: 'Join PawPath', errors, values: req.body });
  try {
    const exists = await get('SELECT id FROM users WHERE email = ? OR username = ?', [email.trim().toLowerCase(), username.trim()]);
    if (exists) return res.status(400).render('signup', { title: 'Join PawPath', errors: ['An account with that email or username already exists.'], values: req.body });
    const hash = await bcrypt.hash(password, 10);
    const memberGeo = requestCoordinates(req.body, String(locality || '').trim(), `member:${email}`);
    const isVet = entity_type === 'Veterinarian / vet clinic';
    const result = await run(`INSERT INTO users (username,email,password_hash,role,locality,entity_type,organisation_name,phone,show_phone,public_email,show_public_email,instagram_handle,show_instagram,website,show_website,verification_document,vet_registration_number,vet_council_name,vet_certificate_status,vet_certificate_provider,latitude,longitude,location_accuracy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      username.trim(), email.trim().toLowerCase(), hash, role || 'Community member', String(locality || '').trim(), entity_type,
      String(organisation_name || '').trim(), String(phone || '').replace(/\s/g, ''), req.body.show_phone === 'on' ? 1 : 0,
      String(public_email || '').trim().toLowerCase(), req.body.show_public_email === 'on' ? 1 : 0,
      String(instagram_handle || '').trim().replace(/^@/, ''), req.body.show_instagram === 'on' ? 1 : 0,
      safeWebsite(website), req.body.show_website === 'on' ? 1 : 0, proofFromRequest(req),
      isVet ? String(vet_registration_number || '').trim() : '', isVet ? String(vet_council_name || '').trim() : '', isVet ? 'Under review' : 'Not submitted', isVet ? 'PawPath admin + council register check' : '',
      memberGeo.latitude, memberGeo.longitude, memberGeo.location_accuracy
    ]);
    req.session.user = { id: result.id, username: username.trim(), email: email.trim().toLowerCase(), verification_status: 'Unverified', is_admin: 0 };
    flash(req, 'success', 'Welcome to PawPath. You can now report or support an animal.'); res.redirect('/dashboard');
  } catch (error) { next(error); }
});
app.get('/login', (req, res) => res.render('login', { title: 'Log in | PawPath', errors: [], values: {} }));
app.post('/login', async (req, res, next) => {
  const { email, password, captcha_answer } = req.body;
  const errors = [];
  if (!captchaOk(req, captcha_answer, req.body.captcha_token)) errors.push('CAPTCHA answer was incorrect. Please try the new question.');
  try {
    const user = await get('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) errors.push('Email or password is incorrect.');
    if (errors.length) return res.status(400).render('login', { title: 'Log in | PawPath', errors, values: { email } });
    req.session.user = { id: user.id, username: user.username, email: user.email, verification_status: user.verification_status, is_admin: Number(user.is_admin) === 1 };
    flash(req, 'success', `Welcome back, ${user.username}.`); res.redirect('/dashboard');
  } catch (error) { next(error); }
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/verification/apply', requireLogin, async (req, res, next) => {
  try {
    const applicant = await get('SELECT entity_type FROM users WHERE id=?', [req.session.user.id]);
    if (applicant?.entity_type === 'Veterinarian / vet clinic') { flash(req, 'error', 'Veterinarians are verified from their own registration certificate, not by another veterinarian.'); return res.redirect('/dashboard'); }
    const existing = await get('SELECT * FROM verification_applications WHERE user_id=?', [req.session.user.id]);
    const vets = await all("SELECT id,username,organisation_name,locality,verification_status FROM users WHERE entity_type='Veterinarian / vet clinic' AND verification_status='Verified' AND id<>? ORDER BY username", [req.session.user.id]);
    const directoryVets = await all("SELECT id,name,city,state,email,phone_primary FROM directory_entries WHERE category='vets' ORDER BY name");
    const values = { ...(existing || {}) };
    if (req.query.directory_vet_id) { values.selected_vet_directory_id = req.query.directory_vet_id; values.selected_vet_user_id = ''; }
    res.render('verification', { title: 'Apply for verification | PawPath', errors: [], values, vets, directoryVets });
  } catch (error) { next(error); }
});

app.get('/vet/certificate', requireLogin, async (req, res, next) => {
  try {
    const profile = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    if (profile?.entity_type !== 'Veterinarian / vet clinic') { flash(req, 'error', 'This certificate form is only for veterinarian accounts.'); return res.redirect('/dashboard'); }
    res.render('vet-certificate', { title: 'Veterinary certificate | PawPath', profile, errors: [] });
  } catch (error) { next(error); }
});

app.post('/vet/certificate', requireLogin, proofUpload.single('verification_document'), async (req, res, next) => {
  try {
    const profile = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    if (profile?.entity_type !== 'Veterinarian / vet clinic') return res.redirect('/dashboard');
    const errors = [];
    if (!String(req.body.vet_registration_number || '').trim()) errors.push('Veterinary registration number is required.');
    if (!String(req.body.vet_council_name || '').trim()) errors.push('Veterinary council name is required.');
    if (!req.file && !profile.verification_document) errors.push('Upload your registration certificate or veterinary professional ID.');
    if (errors.length) return res.status(400).render('vet-certificate', { title: 'Veterinary certificate | PawPath', profile: { ...profile, ...req.body }, errors });
    const document = proofFromRequest(req, profile.verification_document || '');
    await run(`UPDATE users SET verification_document=?,vet_registration_number=?,vet_council_name=?,vet_certificate_status='Under review',vet_certificate_provider='PawPath admin + council register check',vet_certificate_notes=NULL WHERE id=?`, [document, req.body.vet_registration_number.trim(), req.body.vet_council_name.trim(), profile.id]);
    flash(req, 'success', 'Your certificate was submitted for professional-register verification.'); res.redirect('/dashboard');
  } catch (error) { next(error); }
});

app.get('/admin', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const [users, listings, directory, complaints, verifications, vets, stories, offers] = await Promise.all([
      get('SELECT COUNT(*) AS count FROM users'),
      get('SELECT COUNT(*) AS count FROM animals'),
      get('SELECT COUNT(*) AS count FROM directory_entries'),
      get("SELECT COUNT(*) AS count FROM complaints WHERE status IN ('Submitted','Under review','Substantiated')"),
      get('SELECT COUNT(*) AS count FROM verification_applications'),
      get("SELECT COUNT(*) AS count FROM users WHERE entity_type='Veterinarian / vet clinic'"),
      get('SELECT COUNT(*) AS count FROM happy_tails'),
      get('SELECT COUNT(*) AS count FROM applications')
    ]);
    const recentComplaints = await all(`SELECT complaints.*,reporter.username AS reporter_name,
      target_user.username AS target_user_name,directory_entries.name AS target_directory_name,animals.name AS animal_name
      FROM complaints JOIN users AS reporter ON reporter.id=complaints.reporter_user_id
      LEFT JOIN users AS target_user ON target_user.id=complaints.target_user_id
      LEFT JOIN directory_entries ON directory_entries.id=complaints.target_directory_id
      LEFT JOIN animals ON animals.id=complaints.animal_id
      ORDER BY complaints.created_at DESC LIMIT 8`);
    res.render('admin-dashboard', { title: 'Admin control centre | PawPath', counts: {
      users: users.count, listings: listings.count, directory: directory.count,
      complaints: complaints.count, verifications: verifications.count, vets: vets.count,
      stories: stories.count, offers: offers.count
    }, recentComplaints });
  } catch (error) { next(error); }
});

app.get('/admin/users', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const users = await all(`SELECT users.*,COUNT(DISTINCT animals.id) AS listing_count,
      COUNT(DISTINCT complaints.id) AS complaint_count
      FROM users LEFT JOIN animals ON animals.user_id=users.id
      LEFT JOIN complaints ON complaints.target_user_id=users.id
      GROUP BY users.id ORDER BY users.is_admin DESC,users.created_at DESC`);
    res.render('admin-users', { title: 'Manage people | PawPath', users });
  } catch (error) { next(error); }
});

app.get('/admin/listings', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const listings = await all(`SELECT animals.*,users.username,users.email,
      COUNT(DISTINCT applications.id) AS offer_count,COUNT(DISTINCT complaints.id) AS complaint_count
      FROM animals JOIN users ON users.id=animals.user_id
      LEFT JOIN applications ON applications.animal_id=animals.id
      LEFT JOIN complaints ON complaints.animal_id=animals.id
      GROUP BY animals.id,users.username,users.email ORDER BY animals.created_at DESC`);
    res.render('admin-listings', { title: 'Manage listings | PawPath', listings });
  } catch (error) { next(error); }
});

app.get('/admin/directory', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    const category = ['volunteers','vets','organisations'].includes(req.query.category) ? req.query.category : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = 60;
    const filters = []; const params = [];
    if (query) { filters.push('(LOWER(directory_entries.name) LIKE ? OR LOWER(COALESCE(directory_entries.city,\'\')) LIKE ? OR LOWER(COALESCE(directory_entries.state,\'\')) LIKE ?)'); const term = `%${query.toLowerCase()}%`; params.push(term,term,term); }
    if (category) { filters.push('directory_entries.category=?'); params.push(category); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = await get(`SELECT COUNT(*) AS count FROM directory_entries ${where}`, params);
    const entries = await all(`SELECT directory_entries.*,COUNT(DISTINCT complaints.id) AS complaint_count
      FROM directory_entries LEFT JOIN complaints ON complaints.target_directory_id=directory_entries.id
      ${where} GROUP BY directory_entries.id ORDER BY directory_entries.name LIMIT ? OFFSET ?`, [...params,pageSize,(page-1)*pageSize]);
    res.render('admin-directory', { title: 'Manage public directory | PawPath', entries, query, category, page, pages: Math.max(1,Math.ceil(Number(total.count || 0)/pageSize)), total: Number(total.count || 0) });
  } catch (error) { next(error); }
});

app.get('/admin/complaints', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const complaints = await all(`SELECT complaints.*,reporter.username AS reporter_name,reporter.email AS reporter_email,
      target_user.username AS target_user_name,target_user.email AS target_user_email,
      directory_entries.name AS target_directory_name,animals.name AS animal_name
      FROM complaints JOIN users AS reporter ON reporter.id=complaints.reporter_user_id
      LEFT JOIN users AS target_user ON target_user.id=complaints.target_user_id
      LEFT JOIN directory_entries ON directory_entries.id=complaints.target_directory_id
      LEFT JOIN animals ON animals.id=complaints.animal_id ORDER BY complaints.created_at DESC`);
    res.render('admin-complaints', { title: 'Warnings and complaints | PawPath', complaints });
  } catch (error) { next(error); }
});

app.get('/admin/happy-tails', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const stories = await all(`SELECT happy_tails.*,users.username,users.email,animals.name AS animal_name
      FROM happy_tails LEFT JOIN users ON users.id=happy_tails.user_id
      LEFT JOIN animals ON animals.id=happy_tails.animal_id ORDER BY happy_tails.created_at DESC`);
    res.render('admin-happy-tails', { title: 'Manage Happy Tails | PawPath', stories });
  } catch (error) { next(error); }
});

app.get('/admin/offers', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const offers = await all(`SELECT applications.*,animals.name AS animal_name,
      applicant.username AS applicant_name,applicant.email AS applicant_email,
      owner.username AS owner_name,owner.email AS owner_email
      FROM applications JOIN animals ON animals.id=applications.animal_id
      JOIN users AS applicant ON applicant.id=applications.user_id
      JOIN users AS owner ON owner.id=animals.user_id
      ORDER BY applications.created_at DESC`);
    res.render('admin-offers', { title: 'Offers and approvals | PawPath', offers });
  } catch (error) { next(error); }
});

app.post('/admin/users/:id/delete', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const user = await get('SELECT id,username,is_admin FROM users WHERE id=?', [req.params.id]);
    if (!user) { flash(req, 'error', 'That account no longer exists.'); return res.redirect('/admin/users'); }
    if (Number(user.id) === Number(req.session.user.id) || Number(user.is_admin) === 1) { flash(req, 'error', 'Admin accounts cannot be deleted from this screen.'); return res.redirect('/admin/users'); }
    await run("UPDATE verification_applications SET selected_vet_user_id=NULL,status=CASE WHEN status='Under review' THEN 'Awaiting vet claim' ELSE status END WHERE selected_vet_user_id=?", [user.id]);
    await run('UPDATE verification_applications SET reviewed_by_user_id=NULL WHERE reviewed_by_user_id=?', [user.id]);
    await run('DELETE FROM happy_tails WHERE user_id=?', [user.id]);
    await run('DELETE FROM users WHERE id=?', [user.id]);
    flash(req, 'success', `${user.username}'s account and connected listings were deleted.`); res.redirect('/admin/users');
  } catch (error) { next(error); }
});

app.post('/admin/listings/:id/delete', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const listing = await get('SELECT id,name FROM animals WHERE id=?', [req.params.id]);
    if (!listing) { flash(req, 'error', 'That listing no longer exists.'); return res.redirect('/admin/listings'); }
    await run('DELETE FROM animals WHERE id=?', [listing.id]);
    flash(req, 'success', `${listing.name}'s listing was deleted by the administrator.`); res.redirect('/admin/listings');
  } catch (error) { next(error); }
});

app.post('/admin/directory/:id/delete', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const entry = await get('SELECT id,name FROM directory_entries WHERE id=?', [req.params.id]);
    if (!entry) { flash(req, 'error', 'That directory record no longer exists.'); return res.redirect('/admin/directory'); }
    await run("UPDATE verification_applications SET selected_vet_directory_id=NULL,status=CASE WHEN status IN ('Under review','Awaiting vet claim') THEN 'Awaiting vet claim' ELSE status END WHERE selected_vet_directory_id=?", [entry.id]);
    await run('DELETE FROM directory_entries WHERE id=?', [entry.id]);
    flash(req, 'success', `${entry.name} was removed from the public directory.`); res.redirect('/admin/directory');
  } catch (error) { next(error); }
});

app.post('/admin/complaints/:id/status', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const statuses = ['Submitted','Under review','Substantiated','Resolved','Dismissed'];
    if (!statuses.includes(req.body.status)) { flash(req, 'error', 'Choose a valid complaint status.'); return res.redirect('/admin/complaints'); }
    await run('UPDATE complaints SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.body.status,req.params.id]);
    flash(req, 'success', 'Complaint status updated.'); res.redirect('/admin/complaints');
  } catch (error) { next(error); }
});

app.post('/admin/happy-tails/:id/delete', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const story = await get('SELECT id,dog_name FROM happy_tails WHERE id=?', [req.params.id]);
    if (!story) { flash(req, 'error', 'That Happy Tail no longer exists.'); return res.redirect('/admin/happy-tails'); }
    await run('DELETE FROM happy_tails WHERE id=?', [story.id]);
    flash(req, 'success', `${story.dog_name}'s Happy Tail was deleted by the administrator.`); res.redirect('/admin/happy-tails');
  } catch (error) { next(error); }
});

app.get('/admin/vets', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const vets = await all("SELECT * FROM users WHERE entity_type='Veterinarian / vet clinic' ORDER BY CASE vet_certificate_status WHEN 'Under review' THEN 1 WHEN 'Not submitted' THEN 2 ELSE 3 END,username");
    res.render('admin-vets', { title: 'Veterinary credential review | PawPath', vets });
  } catch (error) { next(error); }
});

app.post('/admin/vets/:id/decision', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const vet = await get("SELECT * FROM users WHERE id=? AND entity_type='Veterinarian / vet clinic'", [req.params.id]);
    if (!vet) return res.redirect('/admin/vets');
    const approved = req.body.decision === 'approve';
    if (approved && (!vet.verification_document || !vet.vet_registration_number)) { flash(req, 'error', 'A certificate and registration number are required before approval.'); return res.redirect('/admin/vets'); }
    const certificateStatus = approved ? 'Approved' : 'Rejected';
    await run('UPDATE users SET vet_certificate_status=?,vet_certificate_notes=?,verification_status=?,verified_at=? WHERE id=?', [certificateStatus, String(req.body.notes || '').trim(), approved ? 'Verified' : 'Unverified', approved ? new Date().toISOString() : null, vet.id]);
    await createNotification(vet.id, `vet-certificate-${vet.id}-${Date.now()}`, 'verification', `Veterinary certificate ${certificateStatus.toLowerCase()}`, String(req.body.notes || '').trim() || (approved ? 'Your veterinarian profile is now verified.' : 'Please review the credential notes and submit a corrected certificate.'), '/dashboard');
    pushLive(vet.id, 'notification', { title: `Veterinary certificate ${certificateStatus.toLowerCase()}`, body: approved ? 'Your veterinarian profile is now verified.' : 'Open your dashboard for the review notes.', url: '/dashboard' });
    flash(req, 'success', `${vet.username}'s veterinary credential was ${certificateStatus.toLowerCase()}.`); res.redirect('/admin/vets');
  } catch (error) { next(error); }
});

app.post('/verification/apply', requireLogin, proofUpload.single('proof_document'), async (req, res, next) => {
  const b = req.body;
  const required = ['applicant_type','full_name','phone','address','government_id_type','government_id_reference','residence_proof_reference','pet_experience','household_consent','home_visit_consent','welfare_commitment'];
  const errors = required.filter((field) => !String(b[field] || '').trim()).map((field) => `${field.replaceAll('_', ' ')} is required.`);
  if (!b.selected_vet_user_id && !b.selected_vet_directory_id) errors.push('Choose either a PawPath vet or a listed directory vet.');
  if (b.selected_vet_user_id && b.selected_vet_directory_id) errors.push('Choose only one veterinarian review route.');
  if (!/^\d{10}$/.test(String(b.phone || '').replace(/\s/g, ''))) errors.push('Enter a valid 10-digit phone number.');
  try {
    const applicant = await get('SELECT entity_type FROM users WHERE id=?', [req.session.user.id]);
    if (applicant?.entity_type === 'Veterinarian / vet clinic') { flash(req, 'error', 'Veterinarians use certificate verification and do not request another vet review.'); return res.redirect('/dashboard'); }
    const vets = await all("SELECT id,username,organisation_name,locality,verification_status,phone FROM users WHERE entity_type='Veterinarian / vet clinic' AND verification_status='Verified' AND id<>? ORDER BY username", [req.session.user.id]);
    const directoryVets = await all("SELECT id,name,city,state,email,phone_primary FROM directory_entries WHERE category='vets' ORDER BY name");
    const selectedVet = b.selected_vet_user_id ? vets.find((vet) => Number(vet.id) === Number(b.selected_vet_user_id)) : null;
    const selectedDirectoryVet = b.selected_vet_directory_id ? directoryVets.find((vet) => Number(vet.id) === Number(b.selected_vet_directory_id)) : null;
    if (b.selected_vet_user_id && !selectedVet) errors.push('Choose a verified PawPath veterinarian.');
    if (b.selected_vet_directory_id && !selectedDirectoryVet) errors.push('Choose a valid listed veterinarian.');
    if (errors.length) return res.status(400).render('verification', { title: 'Apply for verification | PawPath', errors, values: b, vets, directoryVets });
    const existing = await get('SELECT id,proof_document,referral_token FROM verification_applications WHERE user_id=?', [req.session.user.id]);
    const vetName = selectedVet?.username || selectedDirectoryVet?.name;
    const vetClinic = selectedVet?.organisation_name || selectedDirectoryVet?.name || vetName;
    const vetContact = selectedVet?.phone || selectedDirectoryVet?.phone_primary || selectedDirectoryVet?.email || 'Share the secure referral link';
    if (!vetName) return res.status(400).render('verification', { title: 'Apply for verification | PawPath', errors: ['Please choose a veterinarian again. Your form details have been kept.'], values: b, vets, directoryVets });
    const values = [b.applicant_type,b.full_name.trim(),b.phone.replace(/\s/g,''),b.address.trim(),b.government_id_type,b.government_id_reference.trim(),vetName,String(vetClinic),String(vetContact),b.residence_proof_reference.trim(),b.pet_experience.trim(),b.household_consent,b.home_visit_consent,b.welfare_commitment];
    const document = proofFromRequest(req, existing?.proof_document || '');
    const referralToken = selectedDirectoryVet ? (existing?.referral_token || crypto.randomBytes(24).toString('hex')) : null;
    const status = selectedDirectoryVet ? 'Awaiting vet claim' : 'Under review';
    if (existing) await run(`UPDATE verification_applications SET applicant_type=?,full_name=?,phone=?,address=?,government_id_type=?,government_id_reference=?,veterinarian_name=?,veterinarian_clinic=?,veterinarian_contact=?,residence_proof_reference=?,pet_experience=?,household_consent=?,home_visit_consent=?,welfare_commitment=?,proof_document=?,selected_vet_user_id=?,selected_vet_directory_id=?,referral_token=?,reviewed_by_user_id=NULL,status=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`, [...values,document,selectedVet?.id || null,selectedDirectoryVet?.id || null,referralToken,status,req.session.user.id]);
    else await run(`INSERT INTO verification_applications (user_id,applicant_type,full_name,phone,address,government_id_type,government_id_reference,veterinarian_name,veterinarian_clinic,veterinarian_contact,residence_proof_reference,pet_experience,household_consent,home_visit_consent,welfare_commitment,proof_document,selected_vet_user_id,selected_vet_directory_id,referral_token,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.session.user.id,...values,document,selectedVet?.id || null,selectedDirectoryVet?.id || null,referralToken,status]);
    await run("UPDATE users SET verification_status='Under review' WHERE id=?", [req.session.user.id]);
    req.session.user.verification_status = 'Under review';
    if (selectedVet) { await createNotification(selectedVet.id, `vet-review-${req.session.user.id}-${Date.now()}`, 'verification', 'New verification request', `${req.session.user.username} selected you to review their verification.`, '/vet/verifications'); pushLive(selectedVet.id, 'notification', { title: 'New verification request', body: `${req.session.user.username} selected you as their reviewing vet.`, url: '/vet/verifications' }); }
    flash(req, 'success', selectedDirectoryVet ? `Referral link created for ${selectedDirectoryVet.name}. Copy it from your dashboard and send it to the vet.` : `Verification sent to ${selectedVet.username}. You will be verified automatically if they approve it.`);
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Verification submission failed:', error);
    try {
      const vets = await all("SELECT id,username,organisation_name,locality,verification_status FROM users WHERE entity_type='Veterinarian / vet clinic' AND verification_status='Verified' AND id<>? ORDER BY username", [req.session.user.id]);
      const directoryVets = await all("SELECT id,name,city,state,email,phone_primary FROM directory_entries WHERE category='vets' ORDER BY name");
      return res.status(500).render('verification', { title: 'Apply for verification | PawPath', errors: ['We could not submit the verification request. Please choose the veterinarian again and retry; your form details are still here.'], values: req.body, vets, directoryVets });
    } catch (renderError) { next(error); }
  }
});

app.get('/vet-referral/:token', async (req, res, next) => {
  try {
    const referral = await get(`SELECT verification_applications.id,verification_applications.status,verification_applications.full_name,verification_applications.selected_vet_directory_id,directory_entries.name AS vet_name,directory_entries.city,directory_entries.state FROM verification_applications JOIN directory_entries ON directory_entries.id=verification_applications.selected_vet_directory_id WHERE verification_applications.referral_token=?`, [req.params.token]);
    if (!referral) return res.status(404).render('error', { title: 'Referral not found | PawPath', message: 'This veterinarian referral link is invalid or no longer available.' });
    const viewer = req.session.user ? await get('SELECT id,username,entity_type,verification_status,vet_certificate_status FROM users WHERE id=?', [req.session.user.id]) : null;
    res.render('vet-referral', { title: `Referral for ${referral.vet_name} | PawPath`, referral, viewer, token: req.params.token });
  } catch (error) { next(error); }
});

app.post('/vet-referral/:token/claim', requireLogin, async (req, res, next) => {
  try {
    const vet = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    const referral = await get('SELECT * FROM verification_applications WHERE referral_token=?', [req.params.token]);
    if (!referral) return res.redirect('/dashboard');
    if (vet?.entity_type !== 'Veterinarian / vet clinic' || vet?.verification_status !== 'Verified') { flash(req, 'error', 'Create a veterinarian account and complete professional credential verification before claiming this referral.'); return res.redirect(`/vet-referral/${req.params.token}`); }
    await run("UPDATE verification_applications SET selected_vet_user_id=?,status='Under review',updated_at=CURRENT_TIMESTAMP WHERE id=?", [vet.id, referral.id]);
    await createNotification(referral.user_id, `referral-claimed-${referral.id}`, 'verification', 'Your veterinarian claimed the referral', `${vet.username} can now review your verification application.`, '/dashboard');
    pushLive(referral.user_id, 'notification', { title: 'Veterinarian referral claimed', body: `${vet.username} can now review your application.`, url: '/dashboard' });
    flash(req, 'success', 'Referral claimed. The volunteer request is now in your verification queue.'); res.redirect('/vet/verifications');
  } catch (error) { next(error); }
});

app.get('/vet/verifications', requireLogin, async (req, res, next) => {
  try {
    const vet = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    if (vet?.entity_type !== 'Veterinarian / vet clinic' || vet?.verification_status !== 'Verified') { flash(req, 'error', 'This review queue is only available to verified vets and clinics.'); return res.redirect('/dashboard'); }
    const applications = await all(`SELECT verification_applications.*,users.username,users.email,users.profile_photo FROM verification_applications JOIN users ON users.id=verification_applications.user_id WHERE selected_vet_user_id=? ORDER BY CASE verification_applications.status WHEN 'Under review' THEN 1 ELSE 2 END,verification_applications.updated_at DESC`, [vet.id]);
    res.render('vet-verifications', { title: 'Vet verification requests | PawPath', applications });
  } catch (error) { next(error); }
});

app.post('/vet/verifications/:id/decision', requireLogin, async (req, res, next) => {
  try {
    const vet = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    const application = await get('SELECT * FROM verification_applications WHERE id=? AND selected_vet_user_id=?', [req.params.id, req.session.user.id]);
    if (vet?.entity_type !== 'Veterinarian / vet clinic' || vet?.verification_status !== 'Verified' || !application) { flash(req, 'error', 'That verification request is not assigned to you.'); return res.redirect('/dashboard'); }
    const status = req.body.decision === 'approve' ? 'Approved' : 'Rejected';
    await run('UPDATE verification_applications SET status=?,reviewer_notes=?,reviewed_by_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, String(req.body.reviewer_notes || '').trim(), vet.id, application.id]);
    await run('UPDATE users SET verification_status=?,verified_at=? WHERE id=?', [status === 'Approved' ? 'Verified' : 'Unverified', status === 'Approved' ? new Date().toISOString() : null, application.user_id]);
    await createNotification(application.user_id, `verification-decision-${application.id}-${Date.now()}`, 'verification', `Vet verification ${status.toLowerCase()}`, String(req.body.reviewer_notes || '').trim() || `${vet.username} ${status === 'Approved' ? 'approved' : 'did not approve'} your verification request.`, '/dashboard');
    pushLive(application.user_id, 'notification', { title: `Vet verification ${status.toLowerCase()}`, body: status === 'Approved' ? 'Your profile is now verified.' : 'Open your dashboard to review the decision.', url: '/dashboard' });
    flash(req, 'success', `Verification ${status.toLowerCase()}. The member profile was updated automatically.`); res.redirect('/vet/verifications');
  } catch (error) { next(error); }
});

app.get('/admin/verifications', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const applications = await all(`SELECT verification_applications.*,users.username,users.email,users.profile_photo,
      selected_vet.username AS selected_vet_name,reviewing_vet.username AS reviewing_vet_name,
      directory_entries.name AS selected_directory_vet_name
      FROM verification_applications JOIN users ON users.id=verification_applications.user_id
      LEFT JOIN users AS selected_vet ON selected_vet.id=verification_applications.selected_vet_user_id
      LEFT JOIN users AS reviewing_vet ON reviewing_vet.id=verification_applications.reviewed_by_user_id
      LEFT JOIN directory_entries ON directory_entries.id=verification_applications.selected_vet_directory_id
      ORDER BY CASE verification_applications.status WHEN 'Under review' THEN 1 ELSE 2 END,verification_applications.created_at DESC`);
    res.render('admin-verifications', { title: 'Verification review | PawPath', applications });
  } catch (error) { next(error); }
});

app.post('/admin/verifications/:id/decision', requireLogin, requireAdmin, async (req, res, next) => {
  flash(req, 'error', 'Member verification decisions are made only by the verified veterinarian selected by the member. Admin access is view-only.');
  res.redirect('/admin/verifications');
});

app.get('/complaints/new', requireLogin, async (req, res, next) => {
  try {
    const reporter = await get('SELECT id,verification_status FROM users WHERE id=?', [req.session.user.id]);
    if (reporter?.verification_status !== 'Verified') { flash(req, 'error', 'Only verified PawPath members can file accountability complaints.'); return res.redirect(req.get('referer') || '/dashboard'); }
    const targetUser = req.query.user_id ? await get('SELECT id,username AS name,entity_type AS type FROM users WHERE id=?', [req.query.user_id]) : null;
    const targetDirectory = req.query.directory_id ? await get('SELECT id,name,category AS type FROM directory_entries WHERE id=?', [req.query.directory_id]) : null;
    const animal = req.query.animal_id ? await get('SELECT id,name FROM animals WHERE id=?', [req.query.animal_id]) : null;
    if ((!targetUser && !targetDirectory) || (targetUser && targetUser.id === reporter.id)) { flash(req, 'error', 'Choose a valid person, clinic, shelter or organisation to report.'); return res.redirect('/profiles'); }
    res.render('complaint-form', { title: 'File an accountability complaint | PawPath', target: targetUser || targetDirectory, targetUser, targetDirectory, animal, errors: [], values: {} });
  } catch (error) { next(error); }
});

app.post('/complaints', requireLogin, async (req, res, next) => {
  try {
    const reporter = await get('SELECT id,verification_status FROM users WHERE id=?', [req.session.user.id]);
    if (reporter?.verification_status !== 'Verified') { flash(req, 'error', 'Only verified PawPath members can file accountability complaints.'); return res.redirect('/dashboard'); }
    const targetUser = req.body.target_user_id ? await get('SELECT id,username AS name,entity_type AS type FROM users WHERE id=?', [req.body.target_user_id]) : null;
    const targetDirectory = req.body.target_directory_id ? await get('SELECT id,name,category AS type FROM directory_entries WHERE id=?', [req.body.target_directory_id]) : null;
    const animal = req.body.animal_id ? await get('SELECT id,name FROM animals WHERE id=?', [req.body.animal_id]) : null;
    const categories = ['Did not provide promised help','Animal welfare concern','Misleading identity or credentials','Unsafe conduct','Payment or fundraising concern','Other'];
    const errors = [];
    if ((!targetUser && !targetDirectory) || (targetUser && targetUser.id === reporter.id)) errors.push('Choose a valid report target.');
    if (!categories.includes(req.body.category)) errors.push('Choose a complaint category.');
    if (String(req.body.description || '').trim().length < 40) errors.push('Describe what happened in at least 40 characters.');
    if (errors.length) return res.status(400).render('complaint-form', { title: 'File an accountability complaint | PawPath', target: targetUser || targetDirectory || { name: 'Unknown record' }, targetUser, targetDirectory, animal, errors, values: req.body });
    const result = await run('INSERT INTO complaints (reporter_user_id,target_user_id,target_directory_id,animal_id,category,description,evidence_reference) VALUES (?,?,?,?,?,?,?)', [reporter.id,targetUser?.id || null,targetDirectory?.id || null,animal?.id || null,req.body.category,String(req.body.description).trim(),String(req.body.evidence_reference || '').trim()]);
    if (targetUser) await createNotification(targetUser.id, `complaint-${result.id}`, 'accountability', 'An accountability complaint was filed', 'A verified member filed a complaint. It is recorded for review; repeated unresolved reports may add a public caution.', '/dashboard');
    flash(req, 'success', 'Complaint recorded for review. A public caution appears only after reports from three distinct verified members.');
    res.redirect(targetUser ? `/profiles/${targetUser.id}` : `/directory/${targetDirectory.id}`);
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).render('error', { title: 'Page not found | PawPath', message: 'This path does not exist. Let’s get you back to helping animals.' }));
app.use((error, req, res, next) => {
  console.error(error);
  const isPrivateProof = req.path.startsWith('/verification') || req.path.startsWith('/vet/certificate');
  const message = error.code === 'LIMIT_FILE_SIZE'
    ? (isPrivateProof ? 'Please upload a verification file smaller than 12 MB.' : 'Please choose a photo smaller than 4 MB.')
    : ['Please choose an image file.','Please upload a PDF or image file.'].includes(error.message)
      ? error.message
      : 'We could not complete that request. Please return to the form and try once more.';
  res.status(500).render('error', { title: 'Something went wrong | PawPath', message });
});

initialiseDatabase().then(() => app.listen(PORT, () => console.log(`PawPath is running at http://localhost:${PORT}`)));
