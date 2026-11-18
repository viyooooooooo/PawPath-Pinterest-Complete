const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
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
  limits: { fileSize: 5 * 1024 * 1024 },
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
    '' AS website,
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

function freshCaptcha(req) {
  const first = Math.floor(Math.random() * 8) + 2;
  const second = Math.floor(Math.random() * 8) + 1;
  req.session.captcha = { question: `${first} + ${second}`, answer: String(first + second) };
}
function captchaOk(req, answer) {
  const correct = req.session.captcha && String(answer || '').trim() === req.session.captcha.answer;
  freshCaptcha(req);
  return correct;
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
  const required = ['name', 'locality'];
  required.forEach((field) => { if (!String(body[field] || '').trim()) errors.push(`${field.replace('_', ' ')} is required.`); });
  return errors;
}

function photoFromRequest(req, existingPhoto = '') {
  if (req.body.remove_photo === 'on') return '';
  if (req.file) return `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  return existingPhoto;
}

function listingValues(body, photoUrl) {
  const locality = String(body.locality || '').trim();
  const coordinates = coordinatesForPlace(locality, '', `listing:${body.name || ''}:${locality}`);
  return [
    String(body.name || '').trim(), body.species || 'Unknown', body.gender || 'Unknown', String(body.age || '').trim() || 'Unknown',
    body.size || 'Unknown', String(body.colour || '').trim() || 'Not added', String(body.temperament || '').trim() || 'Not added',
    body.vaccinated || 'Unknown', body.sterilised || 'Unknown', String(body.medical_notes || '').trim(), locality,
    body.urgency || 'Normal', body.category || 'Up for Adoption', body.status || 'Reported', photoUrl,
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

app.use((req, res, next) => {
  if (!req.session.captcha) freshCaptcha(req);
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.captcha = req.session.captcha;
  delete req.session.flash;
  next();
});

app.get('/', async (req, res, next) => {
  try {
    const urgent = await all(`SELECT * FROM animals WHERE urgency IN ('Critical', 'Needs Help Today') AND status NOT IN ('Adopted', 'Resolved') ORDER BY CASE urgency WHEN 'Critical' THEN 1 ELSE 2 END, created_at DESC LIMIT 3`);
    const stats = await get(`SELECT COUNT(*) AS animals, SUM(CASE WHEN urgency = 'Critical' AND status NOT IN ('Adopted', 'Resolved') THEN 1 ELSE 0 END) AS urgent, SUM(CASE WHEN status = 'Adopted' THEN 1 ELSE 0 END) AS adopted FROM animals`);
    const animals = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id ORDER BY CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, animals.created_at DESC LIMIT 10`);
    const profiles = await all(`SELECT users.*, COUNT(animals.id) AS listing_count FROM users LEFT JOIN animals ON animals.user_id=users.id WHERE users.verification_status='Verified' GROUP BY users.id ORDER BY listing_count DESC, users.username LIMIT 6`);
    const stories = await all(`SELECT rescue_updates.*, animals.name AS animal_name, animals.photo_url FROM rescue_updates JOIN animals ON animals.id = rescue_updates.animal_id ORDER BY rescue_updates.created_at DESC LIMIT 3`);
    res.render('home', { title: 'PawPath | Rescue, foster and adopt responsibly', urgent, stats, animals, stories, profiles, mapAssets: true });
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

app.get('/api/map-data', async (req, res, next) => {
  try {
    const animals = await all(`SELECT id,name,species,locality,urgency,category,status,photo_url,latitude,longitude,location_accuracy
      FROM animals WHERE status NOT IN ('Adopted','Resolved') ORDER BY created_at DESC`);
    const members = await all(`SELECT id,username AS name,entity_type AS category,locality AS location,latitude,longitude,location_accuracy
      FROM users WHERE verification_status='Verified' ORDER BY username`);
    const directory = await all(`SELECT id,name,category,subtype,city,state,address,trust_status,listing_readiness,latitude,longitude,location_accuracy
      FROM directory_entries ORDER BY category,name`);

    const listingPoints = animals.map((animal) => {
      const fallback = coordinatesForPlace(animal.locality, '', `animal:${animal.id}`);
      return {
        id: `listing-${animal.id}`, kind: 'listing', recordId: animal.id, name: animal.name,
        category: animal.category, subtype: animal.species, location: animal.locality,
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
        category: group, subtype: member.category, location: member.location, trust: 'PawPath verified',
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
        trust: entry.listing_readiness === 'service_verified' ? 'Rescue services confirmed' : entry.trust_status === 'awbi_recognised' ? 'AWBI recognised' : 'Source checked',
        latitude: Number(entry.latitude ?? fallback.latitude), longitude: Number(entry.longitude ?? fallback.longitude),
        locationAccuracy: entry.location_accuracy || fallback.location_accuracy, url: `/directory/${entry.id}`
      };
    });
    res.set('Cache-Control', 'public, max-age=300');
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
    res.render('directory-detail', { title: `${entry.name} | PawPath`, entry });
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
    res.render('profile-detail', { title: `${profile.username} | PawPath`, profile, listings, ownListings, listingMatches });
  } catch (error) { next(error); }
});

app.post('/profiles/:id/chat', requireLogin, async (req, res, next) => {
  try {
    const recipient = await get('SELECT id, username, role, verification_status FROM users WHERE id=?', [req.params.id]);
    if (!recipient || recipient.id === req.session.user.id || recipient.verification_status !== 'Verified') {
      flash(req, 'error', 'Choose another verified PawPath member to message.');
      return res.redirect(`/profiles/${req.params.id}`);
    }
    let listing = null;
    if (req.body.listing_id) {
      listing = await get("SELECT * FROM animals WHERE id=? AND user_id=? AND status NOT IN ('Adopted','Resolved')", [req.body.listing_id, req.session.user.id]);
      if (!listing) { flash(req, 'error', 'Please choose one of your active listings.'); return res.redirect(`/profiles/${req.params.id}`); }
      if (String(req.body.message || '').trim().length < 12) { flash(req, 'error', 'Please briefly explain why this animal could be a good fit.'); return res.redirect(`/profiles/${req.params.id}#contact`); }
    }
    const score = listing ? listingMatchScore(listing, recipient) : 0;
    const topic = listing ? `About ${listing.name}` : 'General question';
    let conversation = listing
      ? await get('SELECT id FROM conversations WHERE listing_id=? AND initiator_id=? AND recipient_id=?', [listing.id, req.session.user.id, recipient.id])
      : await get('SELECT id FROM conversations WHERE listing_id IS NULL AND initiator_id=? AND recipient_id=?', [req.session.user.id, recipient.id]);
    if (!conversation) {
      const created = await run('INSERT INTO conversations (listing_id,initiator_id,recipient_id,compatibility_score,topic) VALUES (?,?,?,?,?)', [listing ? listing.id : null, req.session.user.id, recipient.id, score, topic]);
      conversation = { id: created.id };
      const firstMessage = String(req.body.message || '').trim() || (listing
        ? `Hi ${recipient.username}, I think ${listing.name} could be a good match for your support. Would you be open to discussing this listing?`
        : `Hi ${recipient.username}, I would like to ask for your guidance.`);
      await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, firstMessage]);
    }
    flash(req, 'success', listing ? `Conversation started. Compatibility: ${score}%.` : 'Conversation started.');
    res.redirect(`/messages/${conversation.id}`);
  } catch (error) { next(error); }
});

app.post('/profiles/:id/approach', requireLogin, (req, res) => res.redirect(307, `/profiles/${req.params.id}/chat`));

app.get('/messages', requireLogin, async (req, res, next) => {
  try {
    const conversations = await all(`SELECT conversations.*, COALESCE(conversations.topic, animals.name, 'General question') AS topic,
      CASE WHEN conversations.initiator_id=? THEN recipients.username ELSE initiators.username END AS other_username
      FROM conversations
      LEFT JOIN animals ON animals.id=conversations.listing_id
      JOIN users AS initiators ON initiators.id=conversations.initiator_id
      JOIN users AS recipients ON recipients.id=conversations.recipient_id
      WHERE conversations.initiator_id=? OR conversations.recipient_id=?
      ORDER BY conversations.updated_at DESC`, [req.session.user.id, req.session.user.id, req.session.user.id]);
    res.render('messages', { title: 'Messages | PawPath', conversations });
  } catch (error) { next(error); }
});

app.get('/messages/:id', requireLogin, async (req, res, next) => {
  try {
    const conversation = await get(`SELECT conversations.*, COALESCE(conversations.topic, animals.name, 'General question') AS topic,
      initiators.username AS initiator_name, recipients.username AS recipient_name
      FROM conversations LEFT JOIN animals ON animals.id=conversations.listing_id
      JOIN users AS initiators ON initiators.id=conversations.initiator_id
      JOIN users AS recipients ON recipients.id=conversations.recipient_id
      WHERE conversations.id=?`, [req.params.id]);
    if (!conversation || (conversation.initiator_id !== req.session.user.id && conversation.recipient_id !== req.session.user.id)) {
      flash(req, 'error', 'That conversation is not available to you.'); return res.redirect('/messages');
    }
    const messages = await all(`SELECT messages.*, users.username FROM messages JOIN users ON users.id=messages.sender_id WHERE conversation_id=? ORDER BY messages.created_at ASC, messages.id ASC`, [conversation.id]);
    const otherName = conversation.initiator_id === req.session.user.id ? conversation.recipient_name : conversation.initiator_name;
    res.render('conversation', { title: `Chat with ${otherName} | PawPath`, conversation, messages, otherName, errors: [] });
  } catch (error) { next(error); }
});

app.post('/messages/:id', requireLogin, async (req, res, next) => {
  try {
    const conversation = await get('SELECT * FROM conversations WHERE id=?', [req.params.id]);
    if (!conversation || (conversation.initiator_id !== req.session.user.id && conversation.recipient_id !== req.session.user.id)) return res.redirect('/messages');
    const body = String(req.body.body || '').trim();
    if (!body || body.length > 1500) { flash(req, 'error', 'Write a message between 1 and 1,500 characters.'); return res.redirect(`/messages/${conversation.id}`); }
    await run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', [conversation.id, req.session.user.id, body]);
    await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [conversation.id]);
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
    const order = filters.sort === 'urgency' ? `${ownLast} CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, animals.created_at DESC` : `${ownLast} animals.created_at DESC`;
    const animals = await all(`SELECT animals.*, users.username, users.verification_status FROM animals JOIN users ON users.id=animals.user_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order}`, params);
    res.render('animals', { title: 'Explore Animals | PawPath', animals, filters });
  } catch (error) { next(error); }
});

app.get('/animals/new', requireLogin, (req, res) => res.render('animal-form', { title: 'Report a Stray | PawPath', animal: {}, action: '/animals', formTitle: 'Create an animal profile', errors: [] }));
app.post('/animals', requireLogin, upload.single('photo'), async (req, res, next) => {
  const errors = validateAnimal(req.body);
  const uploadedPhoto = photoFromRequest(req);
  if (errors.length) return res.status(400).render('animal-form', { title: 'Fix listing details | PawPath', animal: { ...req.body, photo_url: uploadedPhoto }, action: '/animals', formTitle: 'Create an animal profile', errors });
  try {
    const b = req.body;
    const result = await run(`INSERT INTO animals (user_id,name,species,gender,age,size,colour,temperament,vaccinated,sterilised,medical_notes,locality,urgency,category,status,photo_url,description,contact_details,latitude,longitude,location_accuracy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.session.user.id, ...listingValues(b, uploadedPhoto)]);
    flash(req, 'success', 'Animal profile created—thank you for taking action.');
    res.redirect(`/animals/${result.id}`);
  } catch (error) { next(error); }
});

app.get('/animals/:id', async (req, res, next) => {
  try {
    const animal = await get('SELECT animals.*, users.username, users.verification_status, users.role FROM animals JOIN users ON users.id = animals.user_id WHERE animals.id = ?', [req.params.id]);
    if (!animal) return res.status(404).render('error', { title: 'Not found | PawPath', message: 'That animal profile no longer exists.' });
    const updates = await all('SELECT rescue_updates.*, users.username FROM rescue_updates JOIN users ON users.id = rescue_updates.user_id WHERE animal_id = ? ORDER BY created_at DESC', [animal.id]);
    res.render('animal-detail', { title: `${animal.name} | PawPath`, animal, updates, applicationErrors: [], application: {} });
  } catch (error) { next(error); }
});

app.get('/animals/:id/edit', requireLogin, async (req, res, next) => {
  try {
    const animal = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
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
    await run(`UPDATE animals SET name=?,species=?,gender=?,age=?,size=?,colour=?,temperament=?,vaccinated=?,sterilised=?,medical_notes=?,locality=?,urgency=?,category=?,status=?,photo_url=?,description=?,contact_details=?,latitude=?,longitude=?,location_accuracy=? WHERE id=?`, [...listingValues(b, uploadedPhoto), existing.id]);
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

app.post('/animals/:id/apply', requireLogin, async (req, res, next) => {
  try {
    const animal = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
    if (!animal) return res.redirect('/animals');
    const b = req.body;
    const errors = [];
    ['request_type', 'housing_type', 'locality', 'pet_experience', 'working_hours', 'contact_number', 'message'].forEach((field) => { if (!String(b[field] || '').trim()) errors.push(`${field.replace('_', ' ')} is required.`); });
    if (!/^\d{10}$/.test(String(b.contact_number || '').replace(/\s/g, ''))) errors.push('Enter a valid 10-digit contact number.');
    if (String(b.message || '').trim().length < 20) errors.push('Please write at least 20 characters about why you can help.');
    const updates = await all('SELECT rescue_updates.*, users.username FROM rescue_updates JOIN users ON users.id = rescue_updates.user_id WHERE animal_id = ? ORDER BY created_at DESC', [animal.id]);
    if (errors.length) return res.status(400).render('animal-detail', { title: `${animal.name} | PawPath`, animal, updates, applicationErrors: errors, application: b });
    await run(`INSERT INTO applications (animal_id,user_id,request_type,housing_type,locality,pet_experience,working_hours,contact_number,message,compatibility_score) VALUES (?,?,?,?,?,?,?,?,?,?)`, [animal.id, req.session.user.id, b.request_type, b.housing_type, b.locality.trim(), b.pet_experience, b.working_hours, b.contact_number.replace(/\s/g, ''), b.message.trim(), compatibility(b)]);
    flash(req, 'success', 'Your help offer has been sent to the rescuer.'); res.redirect(`/animals/${animal.id}`);
  } catch (error) { next(error); }
});

app.post('/animals/:id/updates', requireLogin, async (req, res, next) => {
  try {
    const animal = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
    if (!animal || animal.user_id !== req.session.user.id) { flash(req, 'error', 'Only the listing creator can add updates.'); return res.redirect(`/animals/${req.params.id}`); }
    if (String(req.body.update_text || '').trim().length < 8) { flash(req, 'error', 'Please write a fuller rescue update.'); return res.redirect(`/animals/${animal.id}`); }
    await run('INSERT INTO rescue_updates (animal_id,user_id,update_text,update_type) VALUES (?,?,?,?)', [animal.id, req.session.user.id, req.body.update_text.trim(), req.body.update_type || 'Progress update']);
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
    const listings = await all('SELECT * FROM animals WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
    const received = await all(`SELECT applications.*, animals.name AS animal_name, users.username AS applicant_name FROM applications JOIN animals ON animals.id=applications.animal_id JOIN users ON users.id=applications.user_id WHERE animals.user_id=? ORDER BY applications.created_at DESC`, [req.session.user.id]);
    const sent = await all(`SELECT applications.*, animals.name AS animal_name FROM applications JOIN animals ON animals.id=applications.animal_id WHERE applications.user_id=? ORDER BY applications.created_at DESC`, [req.session.user.id]);
    const profile = await get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    const verification = await get('SELECT * FROM verification_applications WHERE user_id=?', [req.session.user.id]);
    res.render('dashboard', { title: 'My Dashboard | PawPath', listings, received, sent, profile, verification });
  } catch (error) { next(error); }
});

app.get('/signup', (req, res) => res.render('signup', { title: 'Join PawPath', errors: [], values: {} }));
app.post('/signup', proofUpload.single('verification_document'), async (req, res, next) => {
  const { username, email, password, confirm_password, captcha_answer, role, locality, entity_type, organisation_name, phone, public_email, instagram_handle, website } = req.body;
  const errors = [];
  if (String(username || '').trim().length < 3) errors.push('Username must have at least 3 characters.');
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) errors.push('Enter a valid email address.');
  if (String(password || '').length < 8) errors.push('Password must have at least 8 characters.');
  if (password !== confirm_password) errors.push('Passwords do not match.');
  if (!Object.values(networkGroups).flatMap((group) => group.values).includes(entity_type)) errors.push('Please choose how you will participate in the PawPath network.');
  if (phone && !/^\d{10}$/.test(String(phone).replace(/\s/g, ''))) errors.push('Enter a valid 10-digit phone number, or leave it blank.');
  if (public_email && !/^\S+@\S+\.\S+$/.test(String(public_email))) errors.push('Enter a valid public email address, or leave it blank.');
  if (website && !safeWebsite(website)) errors.push('Enter a valid website address, or leave it blank.');
  if (!captchaOk(req, captcha_answer)) errors.push('CAPTCHA answer was incorrect. Please try the new question.');
  if (errors.length) return res.status(400).render('signup', { title: 'Join PawPath', errors, values: req.body });
  try {
    const exists = await get('SELECT id FROM users WHERE email = ? OR username = ?', [email.trim().toLowerCase(), username.trim()]);
    if (exists) return res.status(400).render('signup', { title: 'Join PawPath', errors: ['An account with that email or username already exists.'], values: req.body });
    const hash = await bcrypt.hash(password, 10);
    const memberGeo = coordinatesForPlace(locality, '', `member:${email}`);
    const result = await run(`INSERT INTO users (username,email,password_hash,role,locality,entity_type,organisation_name,phone,show_phone,public_email,show_public_email,instagram_handle,show_instagram,website,show_website,verification_document,latitude,longitude,location_accuracy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      username.trim(), email.trim().toLowerCase(), hash, role || 'Community member', String(locality || '').trim(), entity_type,
      String(organisation_name || '').trim(), String(phone || '').replace(/\s/g, ''), req.body.show_phone === 'on' ? 1 : 0,
      String(public_email || '').trim().toLowerCase(), req.body.show_public_email === 'on' ? 1 : 0,
      String(instagram_handle || '').trim().replace(/^@/, ''), req.body.show_instagram === 'on' ? 1 : 0,
      safeWebsite(website), req.body.show_website === 'on' ? 1 : 0, proofFromRequest(req),
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
  if (!captchaOk(req, captcha_answer)) errors.push('CAPTCHA answer was incorrect. Please try the new question.');
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
    const existing = await get('SELECT * FROM verification_applications WHERE user_id=?', [req.session.user.id]);
    res.render('verification', { title: 'Apply for verification | PawPath', errors: [], values: existing || {} });
  } catch (error) { next(error); }
});

app.post('/verification/apply', requireLogin, proofUpload.single('proof_document'), async (req, res, next) => {
  const b = req.body;
  const required = ['applicant_type','full_name','phone','address','government_id_type','government_id_reference','veterinarian_name','veterinarian_clinic','veterinarian_contact','residence_proof_reference','pet_experience','household_consent','home_visit_consent','welfare_commitment'];
  const errors = required.filter((field) => !String(b[field] || '').trim()).map((field) => `${field.replaceAll('_', ' ')} is required.`);
  if (!/^\d{10}$/.test(String(b.phone || '').replace(/\s/g, ''))) errors.push('Enter a valid 10-digit phone number.');
  if (errors.length) return res.status(400).render('verification', { title: 'Apply for verification | PawPath', errors, values: b });
  try {
    const existing = await get('SELECT id, proof_document FROM verification_applications WHERE user_id=?', [req.session.user.id]);
    const values = [b.applicant_type,b.full_name.trim(),b.phone.replace(/\s/g,''),b.address.trim(),b.government_id_type,b.government_id_reference.trim(),b.veterinarian_name.trim(),b.veterinarian_clinic.trim(),b.veterinarian_contact.trim(),b.residence_proof_reference.trim(),b.pet_experience.trim(),b.household_consent,b.home_visit_consent,b.welfare_commitment];
    const document = proofFromRequest(req, existing?.proof_document || '');
    if (existing) await run(`UPDATE verification_applications SET applicant_type=?,full_name=?,phone=?,address=?,government_id_type=?,government_id_reference=?,veterinarian_name=?,veterinarian_clinic=?,veterinarian_contact=?,residence_proof_reference=?,pet_experience=?,household_consent=?,home_visit_consent=?,welfare_commitment=?,proof_document=?,status='Under review',updated_at=CURRENT_TIMESTAMP WHERE user_id=?`, [...values, document, req.session.user.id]);
    else await run(`INSERT INTO verification_applications (user_id,applicant_type,full_name,phone,address,government_id_type,government_id_reference,veterinarian_name,veterinarian_clinic,veterinarian_contact,residence_proof_reference,pet_experience,household_consent,home_visit_consent,welfare_commitment,proof_document) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.session.user.id, ...values, document]);
    await run("UPDATE users SET verification_status='Under review' WHERE id=?", [req.session.user.id]);
    req.session.user.verification_status = 'Under review';
    flash(req, 'success', 'Verification application submitted. Review normally takes 3–5 working days.');
    res.redirect('/dashboard');
  } catch (error) { next(error); }
});

app.get('/admin/verifications', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const applications = await all(`SELECT verification_applications.*, users.username, users.email, users.profile_photo FROM verification_applications JOIN users ON users.id=verification_applications.user_id ORDER BY CASE verification_applications.status WHEN 'Under review' THEN 1 ELSE 2 END, verification_applications.created_at DESC`);
    res.render('admin-verifications', { title: 'Verification review | PawPath', applications });
  } catch (error) { next(error); }
});

app.post('/admin/verifications/:id/decision', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const application = await get('SELECT * FROM verification_applications WHERE id=?', [req.params.id]);
    if (!application) return res.redirect('/admin/verifications');
    const status = req.body.decision === 'approve' ? 'Approved' : 'Rejected';
    await run('UPDATE verification_applications SET status=?,reviewer_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, String(req.body.reviewer_notes || '').trim(), application.id]);
    await run('UPDATE users SET verification_status=?,verified_at=? WHERE id=?', [status === 'Approved' ? 'Verified' : 'Unverified', status === 'Approved' ? new Date().toISOString() : null, application.user_id]);
    flash(req, 'success', `Verification ${status.toLowerCase()}.`);
    res.redirect('/admin/verifications');
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).render('error', { title: 'Page not found | PawPath', message: 'This path does not exist. Let’s get you back to helping animals.' }));
app.use((error, req, res, next) => { console.error(error); const message = error.code === 'LIMIT_FILE_SIZE' ? 'Please choose a photo smaller than 4 MB.' : error.message === 'Please choose an image file.' ? error.message : 'Please try again. If the issue continues, restart the local server.'; res.status(500).render('error', { title: 'Something went wrong | PawPath', message }); });

initialiseDatabase().then(() => app.listen(PORT, () => console.log(`PawPath is running at http://localhost:${PORT}`)));
