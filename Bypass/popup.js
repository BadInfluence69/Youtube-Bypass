const DEFAULTS = {
  enabled: true,
  fullscreenMode: 'player',
  resumePosition: true,
  stallDetect: false,
  maxRetries: 10
};

const toggle = document.getElementById('toggle');
const statusText = document.getElementById('statusText');
const segButtons = [...document.querySelectorAll('#fsMode button')];
const checkboxes = [...document.querySelectorAll('input[type="checkbox"][data-key]')];
const limitSel = document.getElementById('maxRetries');
const blockCountEl = document.getElementById('blockCount');

function paint(cfg) {
  document.body.classList.toggle('on', cfg.enabled);
  toggle.setAttribute('aria-checked', String(cfg.enabled));
  statusText.textContent = cfg.enabled ? 'YouTube Bypass Enabled' : 'YouTube Bypass Disabled';
  segButtons.forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === cfg.fullscreenMode))
  );
  checkboxes.forEach((box) => { box.checked = !!cfg[box.dataset.key]; });
  limitSel.value = String(cfg.maxRetries);
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    chrome.storage.sync.get(DEFAULTS, paint);
  });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

chrome.storage.sync.get(DEFAULTS, paint);

chrome.storage.local.get({ blocksCaught: 0 }, ({ blocksCaught }) => {
  blockCountEl.textContent = blocksCaught === 0
    ? 'No blocks cleared yet'
    : `${plural(blocksCaught, 'block')} cleared so far`;
});

toggle.addEventListener('click', () => {
  chrome.storage.sync.get(DEFAULTS, (cfg) => save({ enabled: !cfg.enabled }));
});

toggle.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    toggle.click();
  }
});

segButtons.forEach((b) =>
  b.addEventListener('click', () => save({ fullscreenMode: b.dataset.mode }))
);

checkboxes.forEach((box) =>
  box.addEventListener('change', () => save({ [box.dataset.key]: box.checked }))
);

limitSel.addEventListener('change', () => save({ maxRetries: Number(limitSel.value) }));
