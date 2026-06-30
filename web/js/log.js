/* Logging + global error capture. Deliberately ES5 so it ALWAYS runs, and can
   report a parse error in the scripts that load after it. Must be the first
   script on the page. */
(function () {
  var logEl = document.getElementById('log');
  window.SCLOG = function (msg) {
    try {
      var d = new Date();
      var t = ('0' + d.getHours()).slice(-2) + ':' +
              ('0' + d.getMinutes()).slice(-2) + ':' +
              ('0' + d.getSeconds()).slice(-2);
      logEl.textContent += t + '  ' + msg + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
  };
  window.onerror = function (message, source, lineno, colno) {
    SCLOG('ERROR: ' + message + '  (line ' + (lineno || '?') + ')');
    var v = document.getElementById('verdict');
    if (v) {
      v.className = 'v-fail';
      v.textContent = '✗ Script error — this browser may be too old to ' +
        'parse the page. See the log below.';
    }
    return false;
  };
  try { document.getElementById('ua').textContent = navigator.userAgent; } catch (e) {}
  SCLOG('boot ok');
})();
