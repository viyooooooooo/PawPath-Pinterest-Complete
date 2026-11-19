(() => {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  document.querySelectorAll('[data-location-picker]').forEach((picker) => {
    const input = picker.querySelector('input[name="locality"]');
    const latitude = picker.querySelector('input[name="latitude"]');
    const longitude = picker.querySelector('input[name="longitude"]');
    const accuracy = picker.querySelector('input[name="location_accuracy"]');
    const results = picker.querySelector('[data-location-results]');
    const status = picker.querySelector('[data-location-status]');
    const detect = picker.querySelector('[data-detect-location]');
    let timer;

    const selectLocation = (place) => {
      input.value = place.label;
      latitude.value = place.latitude;
      longitude.value = place.longitude;
      accuracy.value = place.accuracy || 'exact';
      results.hidden = true;
      status.textContent = place.accuracy === 'approximate' ? '✓ Approximate pin saved — Detect my location for an exact pin' : '✓ Exact map pin saved';
      picker.classList.add('location-confirmed');
    };
    const findPlaces = async () => {
      const query = input.value.trim();
      if (query.length < 3) { results.hidden = true; return; }
      status.textContent = 'Searching real locations…';
      try {
        const response = await fetch(`/api/location-search?q=${encodeURIComponent(query)}`);
        const places = await response.json();
        if (!response.ok) throw new Error('search failed');
        results.innerHTML = places.length ? places.map((place, index) => `<button type="button" data-place="${index}"><strong>${escapeHtml(place.label.split(',')[0])}</strong><span>${escapeHtml(place.label)}</span></button>`).join('') : '<p>No matching Indian location found. Try a nearby landmark.</p>';
        results.hidden = false;
        results.querySelectorAll('[data-place]').forEach((button) => button.addEventListener('click', () => selectLocation(places[Number(button.dataset.place)])));
        status.textContent = places.length ? 'Select the exact matching location.' : 'Try a more specific place name.';
      } catch (error) { status.textContent = 'Search could not connect. Type an address anyway—it will still be saved with a map pin.'; }
    };
    input.addEventListener('input', () => {
      latitude.value = ''; longitude.value = ''; accuracy.value = ''; picker.classList.remove('location-confirmed');
      clearTimeout(timer); timer = setTimeout(findPlaces, 350);
    });
    detect?.addEventListener('click', () => {
      if (!navigator.geolocation) { status.textContent = 'This browser cannot detect your location.'; return; }
      detect.disabled = true; detect.textContent = 'Detecting…'; status.textContent = 'Allow location access in your browser.';
      navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        try {
          const response = await fetch(`/api/location-reverse?lat=${coords.latitude}&lon=${coords.longitude}`);
          const place = await response.json();
          if (!response.ok) throw new Error(place.error);
          selectLocation(place);
        } catch (error) {
          selectLocation({ label: `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`, latitude: coords.latitude, longitude: coords.longitude, accuracy: 'exact' });
          status.textContent = '✓ Exact pin saved (address lookup was unavailable)';
        }
        finally { detect.disabled = false; detect.textContent = '◎ Detect my location'; }
      }, () => { status.textContent = 'Location access was not available. Search an address instead.'; detect.disabled = false; detect.textContent = '◎ Detect my location'; }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
    document.addEventListener('click', (event) => { if (!picker.contains(event.target)) results.hidden = true; });
  });
})();
