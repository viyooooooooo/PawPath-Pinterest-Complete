(() => {
  const story = document.querySelector('[data-about-story]');
  if (!story) return;
  const chapters = [...story.querySelectorAll('[data-about-step]')];
  const rail = story.querySelector('[data-thread-rail]');
  const windowElement = story.querySelector('[data-thread-window]');
  const controls = [...story.querySelectorAll('[data-about-jump]')];
  let activeIndex = 0;

  const show = (index) => {
    activeIndex = Math.max(0, Math.min(chapters.length - 1, index));
    chapters.forEach((chapter, chapterIndex) => chapter.classList.toggle('is-active', chapterIndex === activeIndex));
    controls.forEach((control, controlIndex) => {
      const active = controlIndex === activeIndex;
      control.classList.toggle('is-active', active);
      control.setAttribute('aria-current', active ? 'step' : 'false');
    });
    if (rail && windowElement) rail.style.transform = `translate3d(0, ${-(activeIndex * windowElement.clientHeight)}px, 0)`;
  };

  controls.forEach((control) => control.addEventListener('click', () => {
    const index = Number(control.dataset.aboutJump);
    chapters[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) show(Number(visible.target.dataset.aboutStep));
    }, { threshold: [.25, .45, .65], rootMargin: '-24% 0px -24% 0px' });
    chapters.forEach((chapter) => observer.observe(chapter));
  }

  window.addEventListener('resize', () => show(activeIndex), { passive: true });
  show(0);
})();
