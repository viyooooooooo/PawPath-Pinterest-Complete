(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('[data-tail-reveal]');
  if (reduced) reveals.forEach((node) => node.classList.add('is-visible'));
  else {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: .14 });
    reveals.forEach((node) => observer.observe(node));
  }

  const number = document.querySelector('[data-solid-count]');
  const stage = document.querySelector('[data-impact-stage]');
  if (number && stage) {
    const target = Number(number.dataset.solidCount || 0);
    const revealNumber = () => {
      stage.classList.add('is-visible');
      if (reduced) { number.textContent = target.toLocaleString('en-IN'); return; }
      const started = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / 1100);
        number.textContent = Math.round(target * (1 - Math.pow(1 - progress, 4))).toLocaleString('en-IN');
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { revealNumber(); observer.disconnect(); } }, { threshold: .3 });
    observer.observe(stage);
  }

  const deck = document.querySelector('[data-tail-deck]');
  if (!deck) return;
  const cards = [...deck.querySelectorAll('[data-tail-card]')];
  const picks = [...deck.querySelectorAll('[data-tail-pick]')];
  const show = (index) => {
    cards.forEach((card, cardIndex) => {
      const active = cardIndex === index;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-hidden', String(!active));
    });
    picks.forEach((pick, pickIndex) => {
      const active = pickIndex === index;
      pick.classList.toggle('is-active', active);
      pick.setAttribute('aria-pressed', String(active));
    });
  };
  picks.forEach((pick, index) => pick.addEventListener('click', () => show(index)));
})();
