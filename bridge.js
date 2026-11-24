/* Loaded first inside each app. Lets the hub name a tab after the open document, like a native window.
   It reports the title the app asks for: a change to document.title, or the web build of eframe/egui
   saying "Unhandled egui viewport command: Title(...)" (the app asks for a window title, and the web
   backend has no window to put it on). That message is swallowed here once the title has been passed on. */
(function () {
  if (window.parent === window) return;                     // only inside the hub
  var last = '';
  function send(t) {
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t || t === last) return;
    last = t;
    try { window.parent.postMessage({ source: 'artcraft-hub', type: 'title', title: t }, location.origin); } catch (e) { /* ignore */ }
  }
  function unescapeRust(s) {                                // the title arrives in Rust's {:?} form
    return s.replace(/\\u\{([0-9a-fA-F]+)\}/g, function (_, h) { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
            .replace(/\\([nrt])/g, ' ').replace(/\\(["'\\])/g, '$1');
  }
  try {
    var warn = console.warn;
    console.warn = function () {
      var m = arguments[0];
      if (typeof m === 'string') {
        var x = /Unhandled egui viewport command: Title\("((?:[^"\\]|\\.)*)"\)/.exec(m);
        if (x) { send(unescapeRust(x[1])); return; }
      }
      return warn.apply(console, arguments);
    };
  } catch (e) { /* ignore */ }
  function watch() {
    var t = document.querySelector('title');
    if (t) new MutationObserver(function () { send(document.title); }).observe(t, { childList: true, characterData: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  window.artcraftHub = { setTitle: send };                   // an app can also call this directly
})();
