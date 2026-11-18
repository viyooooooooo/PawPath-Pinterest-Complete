const INDIA_CENTER = [22.9734, 78.6569];

// City centres are used only to place an honest, approximate pin when the
// source record contains a locality but no GPS coordinate. PawPath never
// presents these generated points as an exact doorstep location.
const CITY_CENTERS = {
  indore: [22.7196, 75.8577], 'vijay nagar': [22.7533, 75.8937], palasia: [22.7244, 75.8840],
  bhawarkua: [22.6908, 75.8687], 'scheme 54': [22.7491, 75.8911], rau: [22.6348, 75.8087],
  'sudama nagar': [22.6966, 75.8420], 'bengali square': [22.7196, 75.9037],
  'iim indore road': [22.6241, 75.7956], annapurna: [22.6980, 75.8450], 'geeta bhawan': [22.7188, 75.8845],
  'new delhi': [28.6139, 77.2090], delhi: [28.6139, 77.2090], mumbai: [19.0760, 72.8777],
  kolkata: [22.5726, 88.3639], chennai: [13.0827, 80.2707], bengaluru: [12.9716, 77.5946],
  bangalore: [12.9716, 77.5946], hyderabad: [17.3850, 78.4867], pune: [18.5204, 73.8567],
  jaipur: [26.9124, 75.7873], ahmedabad: [23.0225, 72.5714], lucknow: [26.8467, 80.9462],
  chandigarh: [30.7333, 76.7794], dehradun: [30.3165, 78.0322], bhopal: [23.2599, 77.4126],
  kochi: [9.9312, 76.2673], goa: [15.4909, 73.8278], gurugram: [28.4595, 77.0266],
  faridabad: [28.4089, 77.3178], shimla: [31.1048, 77.1734], hubballi: [15.3647, 75.1240],
  kozhikode: [11.2588, 75.7804], kollam: [8.8932, 76.6141], thrissur: [10.5276, 76.2144],
  ponda: [15.4027, 74.0078], guwahati: [26.1445, 91.7362], patna: [25.5941, 85.1376],
  ranchi: [23.3441, 85.3096], bhubaneswar: [20.2961, 85.8245], nagpur: [21.1458, 79.0882],
  surat: [21.1702, 72.8311], vadodara: [22.3072, 73.1812], visakhapatnam: [17.6868, 83.2185]
};

const STATE_CENTERS = {
  'andhra pradesh': [15.9129, 79.7400], 'arunachal pradesh': [28.2180, 94.7278], assam: [26.2006, 92.9376],
  bihar: [25.0961, 85.3131], chhattisgarh: [21.2787, 81.8661], goa: [15.2993, 74.1240],
  gujarat: [22.2587, 71.1924], haryana: [29.0588, 76.0856], 'himachal pradesh': [31.1048, 77.1734],
  jharkhand: [23.6102, 85.2799], karnataka: [15.3173, 75.7139], kerala: [10.8505, 76.2711],
  'madhya pradesh': [22.9734, 78.6569], maharashtra: [19.7515, 75.7139], manipur: [24.6637, 93.9063],
  meghalaya: [25.4670, 91.3662], mizoram: [23.1645, 92.9376], nagaland: [26.1584, 94.5624],
  odisha: [20.9517, 85.0985], punjab: [31.1471, 75.3412], rajasthan: [27.0238, 74.2179],
  sikkim: [27.5330, 88.5122], 'tamil nadu': [11.1271, 78.6569], telangana: [18.1124, 79.0193],
  tripura: [23.9408, 91.9882], 'uttar pradesh': [26.8467, 80.9462], uttarakhand: [30.0668, 79.0193],
  'west bengal': [22.9868, 87.8550], delhi: [28.7041, 77.1025], chandigarh: [30.7333, 76.7794],
  puducherry: [11.9416, 79.8083], 'jammu and kashmir': [33.7782, 76.5762], ladakh: [34.1526, 77.5771],
  'andaman and nicobar islands': [11.7401, 92.6586], lakshadweep: [10.5667, 72.6417],
  'dadra and nagar haveli and daman and diu': [20.3974, 72.8328]
};

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function jitter([latitude, longitude], seed, radius) {
  const first = hashText(`${seed}:a`) / 4294967295;
  const second = hashText(`${seed}:b`) / 4294967295;
  const angle = first * Math.PI * 2;
  const distance = Math.sqrt(second) * radius;
  const lat = latitude + Math.sin(angle) * distance;
  const lng = longitude + (Math.cos(angle) * distance) / Math.max(0.45, Math.cos(latitude * Math.PI / 180));
  return [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
}

function coordinatesForPlace(place, state, seed = '') {
  const location = normalise(place);
  const stateName = normalise(state);
  const city = Object.keys(CITY_CENTERS).sort((a, b) => b.length - a.length).find((name) => location.includes(name));
  if (city) {
    const [latitude, longitude] = jitter(CITY_CENTERS[city], seed || location, city === 'indore' ? 0.08 : 0.055);
    return { latitude, longitude, location_accuracy: 'locality_approximate' };
  }
  const stateKey = Object.keys(STATE_CENTERS).find((name) => stateName === name || stateName.includes(name) || location.includes(name));
  if (stateKey) {
    const [latitude, longitude] = jitter(STATE_CENTERS[stateKey], seed || `${location}:${stateName}`, location ? 0.95 : 0.6);
    return { latitude, longitude, location_accuracy: location ? 'district_approximate' : 'state_approximate' };
  }
  const [latitude, longitude] = jitter(INDIA_CENTER, seed || location || 'pawpath', 4.5);
  return { latitude, longitude, location_accuracy: 'india_approximate' };
}

module.exports = { coordinatesForPlace };
