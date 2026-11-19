(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const carousel = document.querySelector('[data-rescue-carousel]');
  if (carousel) {
    const slides = [...carousel.querySelectorAll('[data-rescue-slide]')];
    const dots = [...carousel.querySelectorAll('[data-carousel-dot]')];
    let current = 0;
    let timer;
    let touchStart = 0;

    const show = (next) => {
      if (!slides.length) return;
      current = (next + slides.length) % slides.length;
      slides.forEach((slide, index) => {
        const active = index === current;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', String(!active));
      });
      dots.forEach((dot, index) => dot.classList.toggle('is-active', index === current));
    };
    const play = () => { if (!reduceMotion && slides.length > 1) timer = window.setInterval(() => show(current + 1), 6500); };
    const restart = () => { window.clearInterval(timer); play(); };

    carousel.querySelector('[data-carousel-prev]')?.addEventListener('click', () => { show(current - 1); restart(); });
    carousel.querySelector('[data-carousel-next]')?.addEventListener('click', () => { show(current + 1); restart(); });
    dots.forEach((dot) => dot.addEventListener('click', () => { show(Number(dot.dataset.carouselDot)); restart(); }));
    carousel.addEventListener('mouseenter', () => window.clearInterval(timer));
    carousel.addEventListener('mouseleave', play);
    carousel.addEventListener('focusin', () => window.clearInterval(timer));
    carousel.addEventListener('focusout', play);
    carousel.addEventListener('touchstart', (event) => { touchStart = event.changedTouches[0].clientX; }, { passive: true });
    carousel.addEventListener('touchend', (event) => {
      const distance = event.changedTouches[0].clientX - touchStart;
      if (Math.abs(distance) > 45) { show(current + (distance < 0 ? 1 : -1)); restart(); }
    }, { passive: true });
    play();
  }

  const reveals = [...document.querySelectorAll('[data-reveal]')];
  if (reduceMotion) reveals.forEach((item) => item.classList.add('is-visible'));
  else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((item) => observer.observe(item));
  }

  const progress = document.querySelector('.scroll-progress span');
  const impactNumber = document.querySelector('[data-impact-count]');
  if (impactNumber) {
    const target = Number(impactNumber.dataset.impactCount || 0);
    const animateCount = () => {
      if (reduceMotion) { impactNumber.textContent = target.toLocaleString('en-IN'); return; }
      const started = performance.now();
      const tick = (now) => { const p = Math.min(1, (now - started) / 1400); impactNumber.textContent = Math.round(target * (1 - Math.pow(1 - p, 4))).toLocaleString('en-IN'); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    const countObserver = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { animateCount(); countObserver.disconnect(); } }, { threshold: .45 });
    countObserver.observe(impactNumber);
  }
  const scaleItems = [...document.querySelectorAll('[data-scroll-scale]')];
  let framePending = false;
  const updateMotion = () => {
    framePending = false;
    const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (progress) progress.style.transform = `scaleX(${Math.min(1, window.scrollY / scrollable)})`;
    if (reduceMotion) return;
    scaleItems.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const centreDistance = Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2);
      const visibility = Math.max(0, 1 - centreDistance / window.innerHeight);
      item.style.transform = `scale(${(.84 + visibility * .16).toFixed(3)}) rotate(${((1 - visibility) * 2.5).toFixed(2)}deg)`;
    });
  };
  window.addEventListener('scroll', () => {
    if (!framePending) { framePending = true; requestAnimationFrame(updateMotion); }
  }, { passive: true });
  updateMotion();
})();
