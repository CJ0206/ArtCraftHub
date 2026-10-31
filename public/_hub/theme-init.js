// Runs before first paint so the chosen theme never flashes. Dark is the default.
try {
  var t = JSON.parse(localStorage.getItem('hub:theme'));
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
