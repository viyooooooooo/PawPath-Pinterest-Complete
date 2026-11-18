(() => {
  const mapElements = [...document.querySelectorAll('[data-paw-map]')];
  if (!mapElements.length) return;

  const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const dataPromise = fetch('/api/map-data').then((response) => {
    if (!response.ok) throw new Error('Map data could not be loaded.');
    return response.json();
  });

  function isSos(point) {
    return point.kind === 'listing' && ['Critical', 'Needs Help Today'].includes(point.urgency);
  }

  function markerDetails(point) {
    if (isSos(point)) return { className: 'marker-sos', symbol: '!' };
    if (point.kind === 'listing') return { className: 'marker-listing', symbol: point.subtype === 'Cat' ? '🐱' : point.subtype === 'Dog' ? '🐶' : '🐾' };
    if (point.category === 'vets') return { className: 'marker-vets', symbol: '✚' };
    if (point.category === 'organisations') return { className: 'marker-organisations', symbol: '⌂' };
    return { className: 'marker-volunteers', symbol: '♥' };
  }

  function pointPopup(point) {
    const approximate = point.locationAccuracy && point.locationAccuracy !== 'exact';
    const label = point.kind === 'listing' ? `${point.subtype || 'Animal'} · ${point.category}` : `${point.subtype || point.category} · ${point.trust || 'Network record'}`;
    return `<div class="map-popup">
      ${point.photo ? `<img src="${escapeHtml(point.photo)}" alt="${escapeHtml(point.name)}">` : ''}
      <small>${escapeHtml(label)}</small><h3>${escapeHtml(point.name)}</h3>
      <p>${escapeHtml(point.location || 'Location not supplied')}</p>
      ${approximate ? '<p><span class="approximate">Approximate area pin</span></p>' : ''}
      <a href="${escapeHtml(point.url)}">View details →</a>
    </div>`;
  }

  function createMarker(point) {
    const detail = markerDetails(point);
    const icon = L.divIcon({
      className: `paw-marker ${detail.className}`,
      html: `<span>${detail.symbol}</span>`,
      iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -20]
    });
    return L.marker([point.latitude, point.longitude], { icon, title: point.name, riseOnHover: true }).bindPopup(pointPopup(point), { maxWidth: 260 });
  }

  function makeClusterGroup() {
    return L.markerClusterGroup({
      chunkedLoading: true, chunkInterval: 120, chunkDelay: 25, maxClusterRadius: 52,
      showCoverageOnHover: false, spiderfyOnMaxZoom: true, animate: true
    });
  }

  function initMap(element, payload) {
    const mini = element.hasAttribute('data-mini-map');
    const map = L.map(element, { zoomControl: !mini, scrollWheelZoom: !mini, dragging: true, attributionControl: !mini }).setView([22.9734, 78.6569], mini ? 4 : 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const state = { map, element, points: payload.points, group: makeClusterGroup(), mode: 'all', category: '', search: '' };
    map.addLayer(state.group);
    element._pawMap = state;

    const shell = element.closest('[data-map-shell]');
    const countElements = shell ? [...shell.querySelectorAll('[data-map-count], [data-map-total]')] : [];
    const totalOutside = document.querySelector('[data-map-total]');
    if (!mini && totalOutside && !countElements.includes(totalOutside)) countElements.push(totalOutside);

    const filteredPoints = () => state.points.filter((point) => {
      if (state.mode !== 'all' && point.kind !== state.mode) return false;
      if (state.category === 'sos' && !isSos(point)) return false;
      if (state.category && state.category !== 'sos' && point.category !== state.category) return false;
      if (state.search) {
        const text = `${point.name} ${point.location} ${point.subtype} ${point.category}`.toLowerCase();
        if (!text.includes(state.search)) return false;
      }
      return true;
    });

    const render = (fit = false) => {
      const points = filteredPoints();
      state.group.clearLayers();
      const markers = points.map(createMarker);
      state.group.addLayers(markers);
      countElements.forEach((node) => { node.textContent = points.length.toLocaleString('en-IN'); });
      if (fit && markers.length) {
        const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude]));
        map.fitBounds(bounds.pad(.08), { maxZoom: 12, animate: true });
      }
    };
    render(false);

    if (shell) {
      shell.querySelectorAll('[data-map-filter]').forEach((button) => button.addEventListener('click', () => {
        shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.remove('is-active'));
        button.classList.add('is-active');
        state.mode = button.dataset.mapFilter;
        state.category = '';
        shell.querySelectorAll('[data-map-category]').forEach((item) => item.classList.remove('is-active'));
        render(true);
      }));
      shell.querySelectorAll('[data-map-category]').forEach((button) => button.addEventListener('click', () => {
        const active = button.classList.toggle('is-active');
        shell.querySelectorAll('[data-map-category]').forEach((item) => { if (item !== button) item.classList.remove('is-active'); });
        state.category = active ? button.dataset.mapCategory : '';
        if (active) {
          state.mode = button.dataset.mapCategory === 'sos' ? 'listing' : 'network';
          shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.toggle('is-active', item.dataset.mapFilter === state.mode));
        }
        render(true);
      }));
      const search = shell.querySelector('[data-map-search]');
      let searchTimer;
      if (search) search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { state.search = search.value.trim().toLowerCase(); render(Boolean(state.search)); }, 180);
      });
      const nearMe = shell.querySelector('[data-near-me]');
      if (nearMe) nearMe.addEventListener('click', () => {
        nearMe.textContent = 'Finding your location…';
        map.locate({ setView: true, maxZoom: 12, enableHighAccuracy: true });
      });
      map.on('locationfound', (event) => {
        L.marker(event.latlng, { icon: L.divIcon({ className: 'user-location', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map).bindPopup('You are around here').openPopup();
        L.circle(event.latlng, { radius: Math.min(event.accuracy, 1500), color: '#2677d8', fillOpacity: .08, weight: 1 }).addTo(map);
        if (nearMe) nearMe.textContent = '◎ Location found';
      });
      map.on('locationerror', () => { if (nearMe) nearMe.textContent = 'Location unavailable—try again'; });
    }
    setTimeout(() => map.invalidateSize(), 100);
    return state;
  }

  if (typeof L === 'undefined') {
    document.querySelectorAll('[data-map-loading]').forEach((node) => { node.textContent = 'The interactive map could not load. Refresh to try again.'; });
    return;
  }

  dataPromise.then((payload) => {
    mapElements.forEach((element) => initMap(element, payload));
    document.querySelectorAll('[data-map-loading]').forEach((node) => node.classList.add('is-hidden'));
  }).catch((error) => {
    document.querySelectorAll('[data-map-loading]').forEach((node) => { node.textContent = error.message; });
  });

  const story = document.querySelector('[data-map-story]');
  if (story) {
    const steps = [...story.querySelectorAll('[data-story-step]')];
    const puppyTrack = story.querySelector('.puppy-track');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        steps.forEach((step) => step.classList.toggle('is-active', step === entry.target));
        const state = story.querySelector('[data-mini-map]')?._pawMap;
        if (!state) return;
        const index = Number(entry.target.dataset.storyStep);
        if (index === 0) state.map.flyTo([22.9734, 78.6569], 4, { duration: 1.2 });
        if (index === 1) state.map.flyTo([22.7196, 75.8577], 11, { duration: 1.2 });
        if (index === 2) state.map.flyTo([22.7196, 75.8577], 8, { duration: 1.2 });
      });
    }, { rootMargin: '-35% 0px -45% 0px', threshold: .08 });
    steps.forEach((step) => observer.observe(step));

    let scheduled = false;
    const movePuppy = () => {
      scheduled = false;
      const bounds = story.getBoundingClientRect();
      const travel = Math.max(1, bounds.height - window.innerHeight);
      const progress = Math.max(0, Math.min(1, -bounds.top / travel));
      if (puppyTrack) puppyTrack.style.setProperty('--puppy-x', String(Math.round(progress * 82)));
    };
    window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(movePuppy); } }, { passive: true });
    movePuppy();
  }
})();
