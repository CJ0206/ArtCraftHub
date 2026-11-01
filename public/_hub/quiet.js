/* Loaded first inside each app. Hides routine log, info and debug chatter so the browser
   console shows warnings and errors only. Turn off with the QUIET_APPS=0 environment variable. */
(function () {
  try { var noop = function () {}; console.log = noop; console.info = noop; console.debug = noop; } catch (e) { /* ignore */ }
})();
