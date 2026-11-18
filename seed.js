const bcrypt = require('bcryptjs');
const { run, get, initialiseDatabase } = require('./database');

const animals = [
  ['Milo', 'Dog', 'Male', '2 years', 'Medium', 'Brown and white', 'Gentle and food-motivated', 'Yes', 'Yes', 'Recovered from a minor paw injury.', 'Vijay Nagar, Indore', 'Needs Help Today', 'Up for Adoption', 'Adoption Pending', 'https://images.unsplash.com/photo-1558788353-f76d92427f16?auto=format&fit=crop&w=900&q=80', 'Milo is a sweet Indie who loves slow walks, sunny naps and patient humans. He is healthy, vaccinated and ready for a calm forever home.'],
  ['Luna', 'Cat', 'Female', '8 months', 'Small', 'Grey tabby', 'Playful but initially shy', 'Yes', 'No', 'No current medical concern.', 'Palasia, Indore', 'Normal', 'Up for Adoption', 'Reported', 'https://images.unsplash.com/photo-1519052537078-e6302a4968d4?auto=format&fit=crop&w=900&q=80', 'Luna was rescued from a parking area and is learning to trust people. She would thrive in a quiet indoor home.'],
  ['Biscuit', 'Dog', 'Female', '4 years', 'Medium', 'Golden brown', 'Friendly and calm', 'Yes', 'Yes', 'Needs a foster home for two weeks after surgery.', 'Bhawarkua, Indore', 'Critical', 'Urgent Foster Needed', 'Under Care', 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=900&q=80', 'Biscuit has completed surgery and needs a clean, calm foster home while she heals. All medical expenses are covered.'],
  ['Chotu', 'Dog', 'Male', '1 year', 'Small', 'Black', 'Very social and energetic', 'No', 'No', 'Possible skin infection; veterinary check needed.', 'Scheme No. 54, Indore', 'Critical', 'Medical / Rescue SOS', 'Under Care', 'https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&w=900&q=80', 'Chotu is friendly but needs transport to a vet and help with his treatment. He was found near a busy road.'],
  ['Mango', 'Cat', 'Female', '3 years', 'Small', 'Orange', 'Independent and alert', 'Yes', 'Yes', 'Healthy community cat.', 'Rau, Indore', 'Normal', 'Community Feeder Spot', 'Reported', 'https://images.unsplash.com/photo-1495360010541-f48722b34f7d?auto=format&fit=crop&w=900&q=80', 'Mango lives near a hostel lane. Locals are coordinating meals and annual health checks for her.'],
  ['Toffee', 'Dog', 'Male', '5 months', 'Small', 'Cream', 'Curious and playful', 'Partially', 'No', 'Deworming completed; needs final vaccination.', 'Sudama Nagar, Indore', 'Needs Help Today', 'Urgent Foster Needed', 'Foster Needed', 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=80', 'Toffee is a lively puppy who needs a safe temporary home until he completes his vaccination schedule.'],
  ['Simba', 'Cat', 'Male', '2 years', 'Medium', 'Ginger', 'Affectionate and relaxed', 'Yes', 'Yes', 'Healthy.', 'Bengali Square, Indore', 'Normal', 'Up for Adoption', 'Adopted', 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=900&q=80', 'Simba has found his forever family. His profile stays here as a happy PawPath success story.'],
  ['Nala', 'Dog', 'Female', '3 years', 'Medium', 'White with black ears', 'Cautious but gentle', 'Yes', 'Yes', 'Ear infection treatment completed.', 'IIM Indore Road', 'Normal', 'Community Feeder Spot', 'Resolved', 'https://images.unsplash.com/photo-1561037404-61cd46aa615b?auto=format&fit=crop&w=900&q=80', 'Nala is a sterilised community dog cared for by a small local volunteer group.']
];

async function seed() {
  await initialiseDatabase();
  const existing = await get('SELECT id FROM users WHERE email = ?', ['rescue@pawpath.local']);
  let userId;
  if (existing) userId = existing.id;
  else {
    const passwordHash = await bcrypt.hash('PawPath123', 10);
    const result = await run('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', ['PawPath Rescue', 'rescue@pawpath.local', passwordHash]);
    userId = result.id;
  }
  const count = await get('SELECT COUNT(*) AS count FROM animals');
  if (count.count === 0) {
    for (const animal of animals) {
      await run(`INSERT INTO animals (user_id, name, species, gender, age, size, colour, temperament, vaccinated, sterilised, medical_notes, locality, urgency, category, status, photo_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [userId, ...animal]);
    }
    const milo = await get('SELECT id FROM animals WHERE name = ?', ['Milo']);
    const biscuit = await get('SELECT id FROM animals WHERE name = ?', ['Biscuit']);
    await run('INSERT INTO rescue_updates (animal_id, user_id, update_text, update_type) VALUES (?, ?, ?, ?)', [milo.id, userId, 'Milo completed his health check and is ready to meet potential adopters.', 'Health update']);
    await run('INSERT INTO rescue_updates (animal_id, user_id, update_text, update_type) VALUES (?, ?, ?, ?)', [biscuit.id, userId, 'Biscuit is recovering well after surgery. A quiet temporary home would make a huge difference.', 'Foster appeal']);
  }
  console.log('PawPath database is ready. Demo login: rescue@pawpath.local / PawPath123');
}

seed().catch((error) => { console.error(error); process.exit(1); });
