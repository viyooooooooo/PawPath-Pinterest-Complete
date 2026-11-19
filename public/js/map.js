(async () => {
  const mapElements = [...document.querySelectorAll('[data-paw-map]')];
  if (!mapElements.length) return;
  let maplibregl;
  const moduleUrls = [
    'https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl.mjs',
    'https://cdn.jsdelivr.net/npm/maplibre-gl@6.19.0/dist/maplibre-gl.mjs'
  ];
  for (const moduleUrl of moduleUrls) {
    try {
      maplibregl = await import(moduleUrl);
      break;
    } catch (error) {
      // Try the next CDN when a provider is temporarily unavailable.
    }
  }
  if (!maplibregl) {
    document.querySelectorAll('[data-map-loading]').forEach((node) => {
      node.textContent = 'The interactive map could not load. Check your connection and refresh.';
    });
    return;
  }
  const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const dataPromise = fetch('/api/map-data').then((response) => {
    if (!response.ok) throw new Error('Map data could not be loaded.');
    return response.json();
  });

  function isSos(point) { return point.kind === 'listing' && ['Critical', 'Needs Help Today'].includes(point.urgency); }
  function pointColor(point) {
    if (isSos(point)) return '#d94b3d';
    if (point.kind === 'listing') return '#e6a62f';
    if (point.category === 'vets') return '#2f80c9';
    if (point.category === 'organisations') return '#7553b8';
    return '#16857a';
  }
  function pointIcon(point) {
    if (isSos(point)) return 'paw-sos';
    if (point.kind === 'listing') {
      if (String(point.subtype).toLowerCase() === 'dog') return 'paw-dog';
      if (String(point.subtype).toLowerCase() === 'cat') return 'paw-cat';
      return 'paw-animal';
    }
    if (point.category === 'vets') return 'paw-vet';
    if (point.category === 'organisations') return 'paw-shelter';
    return 'paw-volunteer';
  }
  function addMarkerImages(map) {
    const markers = {
      'paw-sos': ['🚨', '#d94b3d'],
      'paw-dog': ['🐕', '#e6a62f'],
      'paw-cat': ['🐈', '#e6a62f'],
      'paw-animal': ['🐾', '#e6a62f'],
      'paw-vet': ['🩺', '#2f80c9'],
      'paw-shelter': ['🏠', '#7553b8'],
      'paw-volunteer': ['🧑', '#16857a']
    };
    Object.entries(markers).forEach(([id, [emoji, color]]) => {
      if (map.hasImage(id)) return;
      const canvas = document.createElement('canvas');
      canvas.width = 72; canvas.height = 72;
      const context = canvas.getContext('2d');
      context.beginPath(); context.arc(36, 36, 29, 0, Math.PI * 2);
      context.fillStyle = 'rgba(255,255,255,.96)'; context.fill();
      context.lineWidth = 7; context.strokeStyle = color; context.stroke();
      context.font = '34px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(emoji, 36, 37);
      map.addImage(id, context.getImageData(0, 0, 72, 72), { pixelRatio: 2 });
    });
  }
  function keepBaseMapReadable(map) {
    (map.getStyle().layers || []).forEach((layer) => {
      if (layer.type !== 'line') return;
      const id = String(layer.id || '').toLowerCase();
      if (!/(road|highway|motorway|trunk|boundary|border)/.test(id)) return;
      try { map.setPaintProperty(layer.id, 'line-opacity', /(boundary|border)/.test(id) ? 0.72 : 0.62); } catch (error) { /* Keep an incompatible source layer unchanged. */ }
    });
  }
  function toGeoJson(points) {
    return {
      type: 'FeatureCollection',
      features: points.map((point) => ({
        type: 'Feature', id: point.id,
        geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
        properties: { ...point, color: pointColor(point), icon: pointIcon(point), sos: isSos(point) ? 1 : 0, photo: point.photo || '' }
      }))
    };
  }
  function pointPopup(point) {
    const approximate = point.locationAccuracy && point.locationAccuracy !== 'exact';
    const label = point.kind === 'listing' ? `${point.subtype || 'Animal'} · ${point.category}` : `${point.subtype || point.category} · ${point.trust || 'Network record'}`;
    return `<div class="map-popup">${point.photo ? `<img src="${escapeHtml(point.photo)}" alt="${escapeHtml(point.name)}">` : ''}<small>${escapeHtml(label)}</small><h3>${escapeHtml(point.name)}</h3><p>${escapeHtml(point.location || 'Location not supplied')}</p>${approximate ? '<p><span class="approximate">Approximate area pin</span></p>' : ''}<a href="${escapeHtml(point.url)}">View details →</a></div>`;
  }
  function preferEnglishPlaceLabels(map) {
    const style = map.getStyle();
    (style.layers || []).forEach((layer) => {
      if (layer.type !== 'symbol') return;
      const id = String(layer.id || '').toLowerCase();
      const placeLabel = /(country|state|province|city|town|village|settlement|place).*(label|name)|(label|name).*(country|state|province|city|town|village|settlement|place)/.test(id);
      if (!placeLabel) return;
      try { map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]); } catch (error) { /* Style layer does not expose a compatible text field. */ }
    });
  }

  function initMap(element, payload) {
    const mini = element.hasAttribute('data-mini-map');
    const map = new maplibregl.Map({
      container: element,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: [78.6569, 22.9734], zoom: mini ? 3.35 : 4.25,
      minZoom: 3.15, maxZoom: 18, maxBounds: [[60, 4], [101, 38]], attributionControl: !mini,
      interactive: !mini, fadeDuration: 250, cooperativeGestures: !mini
    });
    if (!mini) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const state = { map, element, points: payload.points, mode: 'all', category: '', search: '', loaded: false };
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
      countElements.forEach((node) => { node.textContent = points.length.toLocaleString('en-IN'); });
      if (state.loaded) map.getSource('pawpath-points')?.setData(toGeoJson(points));
      if (fit && points.length) {
        const bounds = points.reduce((box, point) => box.extend([point.longitude, point.latitude]), new maplibregl.LngLatBounds());
        map.fitBounds(bounds, { padding: mini ? 15 : 70, maxZoom: 12, duration: 1100 });
      }
    };

    map.on('load', () => {
      state.loaded = true;
      preferEnglishPlaceLabels(map);
      keepBaseMapReadable(map);
      addMarkerImages(map);
      map.addSource('pawpath-points', { type: 'geojson', data: toGeoJson(filteredPoints()), cluster: false });
      map.addLayer({ id: 'pawpath-points', type: 'symbol', source: 'pawpath-points', layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3.15, 0.72, 8, 0.9, 13, 1.08],
        'icon-allow-overlap': false,
        'icon-ignore-placement': false,
        'icon-padding': 2
      }});
      if (!mini) {
        map.on('click', 'pawpath-points', (event) => {
          const feature = event.features?.[0];
          if (!feature) return;
          new maplibregl.Popup({ offset: 14, maxWidth: '270px' }).setLngLat(feature.geometry.coordinates).setHTML(pointPopup(feature.properties)).addTo(map);
        });
      }
      render(false);
      document.querySelectorAll('[data-map-loading]').forEach((node) => node.classList.add('is-hidden'));
    });

    if (shell) {
      shell.querySelectorAll('[data-map-filter]').forEach((button) => button.addEventListener('click', () => {
        shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.remove('is-active')); button.classList.add('is-active');
        state.mode = button.dataset.mapFilter; state.category = '';
        shell.querySelectorAll('[data-map-category]').forEach((item) => item.classList.remove('is-active')); render(true);
      }));
      shell.querySelectorAll('[data-map-category]').forEach((button) => button.addEventListener('click', () => {
        const active = button.classList.toggle('is-active');
        shell.querySelectorAll('[data-map-category]').forEach((item) => { if (item !== button) item.classList.remove('is-active'); });
        state.category = active ? button.dataset.mapCategory : '';
        if (active) { state.mode = state.category === 'sos' ? 'listing' : 'network'; shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.toggle('is-active', item.dataset.mapFilter === state.mode)); }
        render(true);
      }));
      const search = shell.querySelector('[data-map-search]'); let searchTimer;
      search?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = search.value.trim().toLowerCase(); render(Boolean(state.search)); }, 180); });
      const nearMe = shell.querySelector('[data-near-me]');
      nearMe?.addEventListener('click', () => {
        nearMe.textContent = 'Finding your location…';
        navigator.geolocation.getCurrentPosition(({ coords }) => {
          const marker = document.createElement('span'); marker.className = 'user-location';
          new maplibregl.Marker({ element: marker }).setLngLat([coords.longitude, coords.latitude]).setPopup(new maplibregl.Popup().setText('You are around here')).addTo(map);
          map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 11.5, duration: 1200 }); nearMe.textContent = '◎ Location found';
        }, () => { nearMe.textContent = 'Location unavailable—try again'; }, { enableHighAccuracy: true, timeout: 10000 });
      });
    }
    return state;
  }

  dataPromise.then((payload) => mapElements.forEach((element) => initMap(element, payload))).catch((error) => { document.querySelectorAll('[data-map-loading]').forEach((node) => { node.textContent = error.message; }); });

  const story = document.querySelector('[data-map-story]');
  if (story) {
    const steps = [...story.querySelectorAll('[data-story-step]')];
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        steps.forEach((step) => step.classList.toggle('is-active', step === entry.target));
        const state = story.querySelector('[data-mini-map]')?._pawMap; if (!state) return;
        const index = Number(entry.target.dataset.storyStep);
        if (index === 0) state.map.flyTo({ center: [78.6569, 22.9734], zoom: 3.35, duration: 1300 });
        if (index === 1) state.map.flyTo({ center: [75.8577, 22.7196], zoom: 10.6, duration: 1500 });
        if (index === 2) state.map.flyTo({ center: [75.8577, 22.7196], zoom: 7.6, duration: 1300 });
      });
    }, { rootMargin: '-35% 0px -45% 0px', threshold: .08 });
    steps.forEach((step) => observer.observe(step));
  }
})();
