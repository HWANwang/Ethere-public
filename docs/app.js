const frame = document.querySelector('[data-demo-frame]');
const phone = document.querySelector('.phone');
const buttons = [...document.querySelectorAll('[data-scenario]')];
let ready = false;
let pending = '';

function deliver(name) {
  if (!ready) { pending = name; return; }
  frame.contentWindow?.postMessage({ type: 'ethere-demo-scenario', name }, location.origin);
}

function selectScenario(button) {
  buttons.forEach((item) => item.classList.toggle('is-active', item === button));
  deliver(button.dataset.scenario);
  if (window.matchMedia('(max-width: 780px)').matches) frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

frame.addEventListener('load', () => {
  ready = true;
  phone.classList.remove('is-dark');
  if (pending) { deliver(pending); pending = ''; }
});

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'ethere-demo-theme') return;
  phone.classList.toggle('is-dark', event.data.dark === true);
});

document.querySelector('[data-demo-back]').addEventListener('click', () => {
  if (ready) frame.contentWindow?.EthereDemoBack?.();
});

for (const button of buttons) {
  button.addEventListener('click', () => selectScenario(button));
}
