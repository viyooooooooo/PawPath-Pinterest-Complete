(() => {
  if (!window.EventSource) return;
  let audioReady = false;
  document.addEventListener('pointerdown', () => { audioReady = true; }, { once: true });

  const ping = () => {
    if (!audioReady) return;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 760;
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.18);
    } catch (error) { /* browser sound is optional */ }
  };
  const toast = (title, body, url) => {
    let tray = document.querySelector('.live-toast-tray');
    if (!tray) { tray = document.createElement('aside'); tray.className = 'live-toast-tray'; document.body.appendChild(tray); }
    const item = document.createElement('a'); item.className = 'live-toast'; item.href = url || '#';
    const strong = document.createElement('strong'); strong.textContent = title;
    const text = document.createElement('span'); text.textContent = body || '';
    item.append(strong, text); tray.prepend(item); setTimeout(() => item.remove(), 7000);
  };
  const bump = (selector) => {
    const link = document.querySelector(selector); if (!link) return;
    let badge = link.querySelector('span');
    if (!badge) { badge = document.createElement('span'); badge.textContent = '0'; link.appendChild(badge); }
    badge.textContent = String(Math.min(99, Number(badge.textContent.replace('+', '')) + 1));
  };
  const stack = document.querySelector('[data-message-stack]');
  const conversationId = stack?.dataset.conversationId;
  let lastMessageId = Number(stack?.dataset.lastMessageId || 0);
  const appendMessages = async () => {
    if (!conversationId) return;
    const response = await fetch(`/api/messages/${conversationId}/since?after=${lastMessageId}`);
    if (!response.ok) return;
    const messages = await response.json();
    for (const message of messages) {
      if (Number(message.sender_id) === Number(stack.dataset.currentUserId)) continue;
      const line = document.createElement('div'); line.className = 'message-line';
      const bubble = document.createElement('div'); bubble.className = 'message-bubble';
      const p = document.createElement('p'); p.textContent = message.body;
      const small = document.createElement('small'); small.textContent = `${message.username} · ${new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      bubble.append(p, small); line.appendChild(bubble); stack.appendChild(line); lastMessageId = Math.max(lastMessageId, Number(message.id));
    }
    if (messages.length) stack.scrollTop = stack.scrollHeight;
  };

  const stream = new EventSource('/api/live');
  stream.addEventListener('message', (event) => {
    const data = JSON.parse(event.data); ping();
    if (String(data.conversationId) === String(conversationId)) appendMessages();
    else { bump('[data-live-messages]'); toast(`New message from ${data.sender}`, data.body, `/messages/${data.conversationId}`); }
  });
  ['offer', 'offer_update', 'notification'].forEach((name) => stream.addEventListener(name, (event) => {
    const data = JSON.parse(event.data); ping(); bump('[data-live-notifications]');
    toast(data.title || 'PawPath update', data.body || data.status || '', data.url || (data.offerId ? `/offers/${data.offerId}` : '/notifications'));
  }));

  const form = document.querySelector('[data-live-compose]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = form.querySelector('textarea'); const body = textarea.value.trim(); if (!body) return;
    const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ body }) });
    if (!response.ok) { form.submit(); return; }
    const message = await response.json();
    const line = document.createElement('div'); line.className = 'message-line message-own';
    const bubble = document.createElement('div'); bubble.className = 'message-bubble';
    const p = document.createElement('p'); p.textContent = body; const small = document.createElement('small'); small.textContent = `You · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    bubble.append(p, small); line.appendChild(bubble); stack.appendChild(line); lastMessageId = Math.max(lastMessageId, Number(message.id)); textarea.value = ''; stack.scrollTop = stack.scrollHeight;
  });
})();
