const bcrypt = require('bcryptjs');
const { run, get, initialiseDatabase } = require('./database');

const people = [
  ['Aarohi Mehta','aarohi@pawpath.local','Independent rescuer','Vijay Nagar, Indore','Coordinates vaccination drives and patient foster homes for Indies.','https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=500&q=80'],
  ['Dr Kabir Shah','kabir@pawpath.local','Veterinarian','Palasia, Indore','Small-animal veterinarian supporting emergency triage and post-operative care.','https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=500&q=80'],
  ['Naina Verma','naina@pawpath.local','Verified adopter','Bhawarkua, Indore','Experienced pet parent with a calm home and a soft spot for senior dogs.','https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=500&q=80'],
  ['Rohan Kulkarni','rohan@pawpath.local','Foster volunteer','Scheme 54, Indore','Short-term foster for puppies and injured community dogs.','https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=500&q=80'],
  ['Isha Nair','isha@pawpath.local','Community feeder','Rau, Indore','Runs a documented feeding and sterilisation route across three neighbourhoods.','https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=500&q=80'],
  ['Dev Malhotra','dev@pawpath.local','Transport volunteer','Sudama Nagar, Indore','Provides safe transport to clinics and foster homes after college hours.','https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=500&q=80'],
  ['Meera Joshi','meera@pawpath.local','Verified adopter','Bengali Square, Indore','Cat parent and adoption counsellor focused on indoor-home readiness.','https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=500&q=80'],
  ['Arjun Rao','arjun@pawpath.local','Independent rescuer','IIM Indore Road','Documents rescue cases and coordinates treatment fundraising transparently.','https://images.unsplash.com/photo-1507591064344-4c6ce005b128?auto=format&fit=crop&w=500&q=80'],
  ['Sana Khan','sana@pawpath.local','Foster volunteer','Annapurna, Indore','Quiet foster home for recovering cats and small dogs.','https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=500&q=80'],
  ['Dr Rhea Kapoor','rhea@pawpath.local','Veterinarian','Geeta Bhawan, Indore','Veterinary surgeon reviewing urgent cases and adopter medical preparedness.','https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=500&q=80']
];

const listings = [
  [0,'Milo','Dog','Male','2 years','Medium','Brown and white','Gentle and food-motivated','Yes','Yes','Healthy and adoption-ready.','Vijay Nagar, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1558788353-f76d92427f16?auto=format&fit=crop&w=900&q=80','Milo is a patient Indie who enjoys slow walks and would thrive with a thoughtful family.'],
  [1,'Biscuit','Dog','Female','4 years','Medium','Golden brown','Calm and trusting','Yes','Yes','Recovering after surgery; follow-up booked.','Palasia, Indore','Critical','Medical / Rescue SOS','Under Care','https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=900&q=80','Biscuit needs monitored recovery support and a quiet foster space for fourteen days.'],
  [2,'Luna','Cat','Female','8 months','Small','Grey tabby','Playful, initially shy','Yes','No','No current medical concern.','Bhawarkua, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1519052537078-e6302a4968d4?auto=format&fit=crop&w=900&q=80','Luna is learning to trust people and needs a secure indoor home with patient humans.'],
  [3,'Toffee','Dog','Male','5 months','Small','Cream','Curious and playful','Partially','No','Final vaccination due next week.','Scheme 54, Indore','Needs Help Today','Urgent Foster Needed','Foster Needed','https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=80','Toffee needs a safe temporary home until his vaccination schedule is complete.'],
  [4,'Mango','Cat','Female','3 years','Small','Orange','Independent and alert','Yes','Yes','Healthy community cat.','Rau, Indore','Normal','Community Feeder Spot','Monitored','https://images.unsplash.com/photo-1495360010541-f48722b34f7d?auto=format&fit=crop&w=900&q=80','Mango lives near a hostel lane and has a coordinated feeding and annual health plan.'],
  [5,'Chotu','Dog','Male','1 year','Small','Black','Social and energetic','No','No','Possible skin infection; assessment needed.','Sudama Nagar, Indore','Critical','Medical / Rescue SOS','Reported','https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&w=900&q=80','Chotu needs transport to a veterinary clinic and support for diagnostic tests.'],
  [6,'Simba','Cat','Male','2 years','Medium','Ginger','Affectionate and relaxed','Yes','Yes','Healthy.','Bengali Square, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=900&q=80','Simba is an affectionate indoor cat looking for a calm permanent home.'],
  [7,'Nala','Dog','Female','3 years','Medium','White with black ears','Cautious but gentle','Yes','Yes','Ear treatment completed.','IIM Indore Road','Normal','Community Feeder Spot','Monitored','https://images.unsplash.com/photo-1561037404-61cd46aa615b?auto=format&fit=crop&w=900&q=80','Nala is a sterilised community dog supported by a documented volunteer group.'],
  [8,'Pepper','Cat','Male','1 year','Small','Black and white','Quiet and affectionate','Yes','Yes','Recovering well from a paw injury.','Annapurna, Indore','Needs Help Today','Urgent Foster Needed','Under Care','https://images.unsplash.com/photo-1573865526739-10659fec78a5?auto=format&fit=crop&w=900&q=80','Pepper needs a low-stress foster home for one week while his paw heals.'],
  [9,'Golu','Dog','Male','6 years','Large','Tan','Friendly and steady','Yes','Yes','Arthritis managed with supplements.','Geeta Bhawan, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=900&q=80','Golu is a gentle older dog best suited to a ground-floor home and relaxed routine.'],
  [0,'Piku','Cat','Female','1 year','Small','Calico','Confident and curious','Yes','Yes','Healthy.','Vijay Nagar, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=900&q=80','Piku is social, litter-trained and ready for a committed indoor family.'],
  [3,'Bruno','Dog','Male','3 years','Large','Black and tan','Protective, warms up slowly','Yes','Yes','Healthy; behaviour consult complete.','Scheme 54, Indore','Normal','Up for Adoption','Available','https://images.unsplash.com/photo-1560807707-8cc77767d783?auto=format&fit=crop&w=900&q=80','Bruno needs an experienced adopter who understands decompression and positive reinforcement.']
];

async function seed() {
  await initialiseDatabase();
  const passwordHash = await bcrypt.hash('PawPath123', 10);
  const ids = [];
  for (const person of people) {
    let user = await get('SELECT id FROM users WHERE email=?', [person[1]]);
    if (!user) {
      const result = await run(`INSERT INTO users (username,email,password_hash,role,locality,bio,profile_photo,verification_status,verified_at) VALUES (?,?,?,?,?,?,?,'Verified',CURRENT_TIMESTAMP)`, [person[0],person[1],passwordHash,person[2],person[3],person[4],person[5]]);
      user = { id: result.id };
    }
    ids.push(user.id);
  }
  await run('UPDATE users SET is_admin=1 WHERE email=?', ['aarohi@pawpath.local']);
  const count = await get('SELECT COUNT(*) AS count FROM animals');
  if (Number(count.count) === 0) {
    for (const item of listings) {
      const [owner,...animal] = item;
      await run(`INSERT INTO animals (user_id,name,species,gender,age,size,colour,temperament,vaccinated,sterilised,medical_notes,locality,urgency,category,status,photo_url,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ids[owner],...animal]);
    }
  }
  console.log('PawPath seed ready: 10 verified demo profiles. Password for each: PawPath123');
}

seed().catch((error) => { console.error(error); process.exit(1); });
