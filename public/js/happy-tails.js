(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('[data-tail-reveal]');
  if (reduced) reveals.forEach((node) => node.classList.add('is-visible'));
  else { const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold: .12 }); reveals.forEach((node,index) => { node.style.setProperty('--tail-delay',`${Math.min(index%4,3)*80}ms`); observer.observe(node); }); }
  const box = document.querySelector('[data-tail-counter]'); const number = box?.querySelector('strong');
  if (box && number) { const target=Number(box.dataset.count||0); const run=()=>{ if(reduced){number.textContent=target.toLocaleString('en-IN');return} const start=performance.now(); const tick=(now)=>{const p=Math.min(1,(now-start)/1500);number.textContent=Math.round(target*(1-Math.pow(1-p,4))).toLocaleString('en-IN');if(p<1)requestAnimationFrame(tick)};requestAnimationFrame(tick)}; const observer=new IntersectionObserver((entries)=>{if(entries.some((entry)=>entry.isIntersecting)){run();observer.disconnect()}},{threshold:.45});observer.observe(box); }
  const progress=document.querySelector('.tails-progress span'); const cards=[...document.querySelectorAll('[data-tail-card]')]; let queued=false;
  const update=()=>{const max=document.documentElement.scrollHeight-innerHeight;if(progress)progress.style.transform=`scaleX(${max>0?scrollY/max:0})`;if(!reduced)cards.forEach((card)=>{const rect=card.getBoundingClientRect();const centre=rect.top+rect.height/2;const distance=Math.min(1,Math.abs(centre-innerHeight/2)/innerHeight);card.style.transform=`scale(${1-distance*.035}) translateY(${(centre-innerHeight/2)*-.018}px)`})};
  addEventListener('scroll',()=>{if(!queued)requestAnimationFrame(()=>{update();queued=false});queued=true},{passive:true});update();
})();
