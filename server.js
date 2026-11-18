const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { run, get, all, initialiseDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'pawpath-local-demo-secret', resave: false, saveUninitialized: false }));

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
function validateAnimal(body) {
  const errors = [];
  const required = ['name', 'species', 'gender', 'age', 'size', 'colour', 'temperament', 'vaccinated', 'sterilised', 'locality', 'urgency', 'category', 'status', 'description'];
  required.forEach((field) => { if (!String(body[field] || '').trim()) errors.push(`${field.replace('_', ' ')} is required.`); });
  if (String(body.description || '').trim().length < 20) errors.push('Description must be at least 20 characters.');
  if (body.photo_url && !/^https?:\/\/.+/i.test(body.photo_url)) errors.push('Photo URL must begin with http:// or https://.');
  return errors;
}
function compatibility(body) {
  let score = 50;
  if (body.pet_experience !== 'None') score += 15;
  if (body.housing_type !== 'Hostel / shared room') score += 15;
  if (Number(body.working_hours) <= 8) score += 10;
  return Math.min(score, 95);
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
    const animals = await all(`SELECT * FROM animals ORDER BY CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, created_at DESC LIMIT 10`);
    const stories = await all(`SELECT rescue_updates.*, animals.name AS animal_name, animals.photo_url FROM rescue_updates JOIN animals ON animals.id = rescue_updates.animal_id ORDER BY rescue_updates.created_at DESC LIMIT 3`);
    res.render('home', { title: 'PawPath | Find a friend. Offer a safe pause.', urgent, stats, animals, stories });
  } catch (error) { next(error); }
});

// Focused discovery pages keep each help flow simple instead of crowding one screen.
app.get('/sos', (req, res) => res.redirect('/animals?category=Medical%20%2F%20Rescue%20SOS&urgency=Critical'));
app.get('/foster', (req, res) => res.redirect('/animals?category=Urgent%20Foster%20Needed'));
app.get('/community', (req, res) => res.redirect('/animals?category=Community%20Feeder%20Spot'));

app.get('/animals', async (req, res, next) => {
  try {
    const filters = { q: req.query.q || '', species: req.query.species || '', category: req.query.category || '', urgency: req.query.urgency || '', status: req.query.status || '', vaccinated: req.query.vaccinated || '', sort: req.query.sort || 'newest' };
    const clauses = [];
    const params = [];
    if (filters.q) { clauses.push('(name LIKE ? OR locality LIKE ? OR description LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
    ['species', 'category', 'urgency', 'status', 'vaccinated'].forEach((key) => { if (filters[key]) { clauses.push(`${key} = ?`); params.push(filters[key]); } });
    const order = filters.sort === 'urgency' ? "CASE urgency WHEN 'Critical' THEN 1 WHEN 'Needs Help Today' THEN 2 ELSE 3 END, created_at DESC" : 'created_at DESC';
    const animals = await all(`SELECT * FROM animals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order}`, params);
    res.render('animals', { title: 'Explore Animals | PawPath', animals, filters });
  } catch (error) { next(error); }
});

app.get('/animals/new', requireLogin, (req, res) => res.render('animal-form', { title: 'Report a Stray | PawPath', animal: {}, action: '/animals', formTitle: 'Create an animal profile', errors: [] }));
app.post('/animals', requireLogin, async (req, res, next) => {
  const errors = validateAnimal(req.body);
  if (errors.length) return res.status(400).render('animal-form', { title: 'Fix listing details | PawPath', animal: req.body, action: '/animals', formTitle: 'Create an animal profile', errors });
  try {
    const b = req.body;
    const result = await run(`INSERT INTO animals (user_id,name,species,gender,age,size,colour,temperament,vaccinated,sterilised,medical_notes,locality,urgency,category,status,photo_url,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.session.user.id, b.name.trim(), b.species, b.gender, b.age.trim(), b.size, b.colour.trim(), b.temperament.trim(), b.vaccinated, b.sterilised, b.medical_notes.trim(), b.locality.trim(), b.urgency, b.category, b.status, b.photo_url.trim(), b.description.trim()]);
    flash(req, 'success', 'Animal profile created—thank you for taking action.');
    res.redirect(`/animals/${result.id}`);
  } catch (error) { next(error); }
});

app.get('/animals/:id', async (req, res, next) => {
  try {
    const animal = await get('SELECT animals.*, users.username FROM animals JOIN users ON users.id = animals.user_id WHERE animals.id = ?', [req.params.id]);
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
app.post('/animals/:id/edit', requireLogin, async (req, res, next) => {
  const errors = validateAnimal(req.body);
  const existing = await get('SELECT * FROM animals WHERE id = ?', [req.params.id]);
  if (!existing || existing.user_id !== req.session.user.id) { flash(req, 'error', 'You can only edit your own listings.'); return res.redirect('/dashboard'); }
  if (errors.length) return res.status(400).render('animal-form', { title: 'Fix listing details | PawPath', animal: { ...req.body, id: req.params.id }, action: `/animals/${req.params.id}/edit`, formTitle: `Edit ${existing.name}'s profile`, errors });
  try {
    const b = req.body;
    await run(`UPDATE animals SET name=?,species=?,gender=?,age=?,size=?,colour=?,temperament=?,vaccinated=?,sterilised=?,medical_notes=?,locality=?,urgency=?,category=?,status=?,photo_url=?,description=? WHERE id=?`, [b.name.trim(), b.species, b.gender, b.age.trim(), b.size, b.colour.trim(), b.temperament.trim(), b.vaccinated, b.sterilised, b.medical_notes.trim(), b.locality.trim(), b.urgency, b.category, b.status, b.photo_url.trim(), b.description.trim(), existing.id]);
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
    res.render('dashboard', { title: 'My Dashboard | PawPath', listings, received, sent });
  } catch (error) { next(error); }
});

app.get('/signup', (req, res) => res.render('signup', { title: 'Join PawPath', errors: [], values: {} }));
app.post('/signup', async (req, res, next) => {
  const { username, email, password, confirm_password, captcha_answer } = req.body;
  const errors = [];
  if (String(username || '').trim().length < 3) errors.push('Username must have at least 3 characters.');
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) errors.push('Enter a valid email address.');
  if (String(password || '').length < 8) errors.push('Password must have at least 8 characters.');
  if (password !== confirm_password) errors.push('Passwords do not match.');
  if (!captchaOk(req, captcha_answer)) errors.push('CAPTCHA answer was incorrect. Please try the new question.');
  if (errors.length) return res.status(400).render('signup', { title: 'Join PawPath', errors, values: { username, email } });
  try {
    const exists = await get('SELECT id FROM users WHERE email = ? OR username = ?', [email.trim().toLowerCase(), username.trim()]);
    if (exists) return res.status(400).render('signup', { title: 'Join PawPath', errors: ['An account with that email or username already exists.'], values: { username, email } });
    const hash = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (username,email,password_hash) VALUES (?,?,?)', [username.trim(), email.trim().toLowerCase(), hash]);
    req.session.user = { id: result.id, username: username.trim(), email: email.trim().toLowerCase() };
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
    req.session.user = { id: user.id, username: user.username, email: user.email };
    flash(req, 'success', `Welcome back, ${user.username}.`); res.redirect('/dashboard');
  } catch (error) { next(error); }
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found | PawPath', message: 'This path does not exist. Let’s get you back to helping animals.' }));
app.use((error, req, res, next) => { console.error(error); res.status(500).render('error', { title: 'Something went wrong | PawPath', message: 'Please try again. If the issue continues, restart the local server.' }); });

initialiseDatabase().then(() => app.listen(PORT, () => console.log(`PawPath is running at http://localhost:${PORT}`)));
