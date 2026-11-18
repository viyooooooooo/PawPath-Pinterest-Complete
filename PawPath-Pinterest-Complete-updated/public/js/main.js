document.querySelectorAll('[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

document.querySelectorAll('[data-validate]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const required = [...form.querySelectorAll('[required]')];
    const empty = required.find((field) => !field.value.trim());
    if (empty) {
      event.preventDefault();
      empty.focus();
      alert('Please fill in all required fields.');
    }
  });
});

// Give search an immediate, gentle response before the next page loads.
document.querySelectorAll('.home-search').forEach((form) => {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button');
    if (button) { button.textContent = '•••'; button.classList.add('is-searching'); }
  });
});

const menuButton = document.querySelector('.menu-button');
const mainNav = document.querySelector('.main-nav');
if (menuButton && mainNav) menuButton.addEventListener('click', () => {
  const open = mainNav.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});
