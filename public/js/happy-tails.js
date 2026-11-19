(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('[data-tail-reveal]');
  if (reduced) reveals.forEach((node) => node.classList.add('is-visible'));
  else {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: .12 });
    reveals.forEach((node) => observer.observe(node));
  }

  const deck = document.querySelector('[data-tail-deck]');
  if (!deck) return;
  const cards = [...deck.querySelectorAll('[data-tail-card]')];
  const activate = (card) => cards.forEach((item) => item.classList.toggle('is-active', item === card));
  cards.forEach((card) => {
    card.addEventListener('mouseenter', () => activate(card));
    card.addEventListener('focus', () => activate(card));
    card.addEventListener('click', () => activate(card));
    card.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const index = cards.indexOf(card) + (event.key === 'ArrowRight' ? 1 : -1);
      cards[Math.max(0, Math.min(cards.length - 1, index))]?.focus();
    });
  });
})();
