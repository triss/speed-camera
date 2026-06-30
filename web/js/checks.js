/* The capability checks. ES5 only (no arrow fns, template literals, optional
   chaining or logical assignment) so it runs on the old browsers it assesses. */
(function () {
  SCLOG('starting capability checks');

  var CHECKS = [
    { group: 'Critical', name: 'Secure context', critical: true,
      gates: 'getUserMedia only runs on HTTPS or localhost',
      run: function () {
        return window.isSecureContext
          ? { status: 'pass', detail: location.origin }
          : { status: 'fail', detail: 'insecure — use https:// or http://localhost' };
      } },
    { group: 'Critical', name: 'getUserMedia (camera)', critical: true,
      gates: 'the entire capture path',
      run: function () {
        return (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
          ? { status: 'pass', detail: 'present' }
          : { status: 'fail', detail: 'not available (old browser or non-secure context)' };
      } },
    { group: 'Critical', name: 'Canvas 2D + getImageData', critical: true,
      gates: 'reading pixels for the CV pipeline',
      run: function () {
        try {
          var c = document.createElement('canvas');
          var g = c.getContext('2d');
          if (!g) return { status: 'fail', detail: 'no 2d context' };
          g.getImageData(0, 0, 1, 1);
          return { status: 'pass', detail: 'pixel access OK' };
        } catch (e) { return { status: 'fail', detail: String(e) }; }
      } },
    { group: 'Critical', name: 'performance.now()', critical: true,
      gates: 'frame timing — speed = metres / seconds depends on it',
      run: function () {
        return (window.performance && typeof performance.now === 'function')
          ? { status: 'pass', detail: 'high-res clock present' }
          : { status: 'fail', detail: 'missing' };
      } },
    { group: 'Critical', name: 'requestAnimationFrame', critical: true,
      gates: 'the processing loop',
      run: function () {
        return (typeof window.requestAnimationFrame === 'function')
          ? { status: 'pass', detail: 'present' }
          : { status: 'fail', detail: 'missing' };
      } },

    { group: 'Performance', name: 'WebAssembly',
      gates: 'optional fast CV core (OpenCV.js / Rust/C engine)',
      run: function () {
        return (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function')
          ? { status: 'pass', detail: 'WASM available' }
          : { status: 'warn', detail: 'no WASM — pipeline must run in plain JS' };
      } },
    { group: 'Performance', name: 'Web Workers',
      gates: 'running CV off the UI thread',
      run: function () {
        return (typeof window.Worker === 'function')
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'CV runs on main thread' };
      } },
    { group: 'Performance', name: 'createImageBitmap',
      gates: 'efficient frame grabs',
      run: function () {
        return (typeof window.createImageBitmap === 'function')
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'fall back to drawImage' };
      } },
    { group: 'Performance', name: 'video.requestVideoFrameCallback',
      gates: 'frame-accurate capture + true fps',
      run: function () {
        return (window.HTMLVideoElement &&
                'requestVideoFrameCallback' in HTMLVideoElement.prototype)
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'absent — sample via rAF instead' };
      } },

    { group: 'Deployment & UX', name: 'enumerateDevices',
      gates: 'choosing the rear camera',
      run: function () {
        return (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'rely on facingMode hint' };
      } },
    { group: 'Deployment & UX', name: 'Wake Lock API',
      gates: 'keeping the screen awake for an always-on sensor',
      run: function () {
        return ('wakeLock' in navigator)
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'no wake lock — screen may sleep' };
      } },
    { group: 'Deployment & UX', name: 'DeviceMotion / Orientation',
      gates: 'the steady-pose probe (web port of stable_capture.py)',
      run: function () {
        return ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window)
          ? { status: 'pass', detail: 'present (iOS needs a permission tap)' }
          : { status: 'warn', detail: 'no motion sensors — calibrate visually' };
      } },
    { group: 'Deployment & UX', name: 'Clipboard write',
      gates: 'exporting calibration / data',
      run: function () {
        return (navigator.clipboard && navigator.clipboard.writeText)
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'fall back to textarea copy' };
      } },
    { group: 'Deployment & UX', name: 'MediaRecorder',
      gates: 'logging event video clips',
      run: function () {
        return (typeof window.MediaRecorder === 'function')
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'no clip recording (stills only)' };
      } },
    { group: 'Deployment & UX', name: 'IndexedDB',
      gates: 'accumulating the event log on-device',
      run: function () {
        return (window.indexedDB)
          ? { status: 'pass', detail: 'present' }
          : { status: 'warn', detail: 'fall back to localStorage' };
      } },
    { group: 'Deployment & UX', name: 'Web Share with files',
      gates: 'one-tap share to WhatsApp / Email',
      run: function () {
        if (!navigator.share) return { status: 'warn', detail: 'no Web Share — use download' };
        var canFiles = false;
        try { canFiles = !!(navigator.canShare && navigator.canShare({ files: [] })); } catch (e) {}
        return canFiles
          ? { status: 'pass', detail: 'file sharing supported' }
          : { status: 'warn', detail: 'share present, files maybe not — test on device' };
      } }
  ];

  var report = document.getElementById('report');
  var groups = {};
  var order = [];
  var criticalFail = false, anyWarn = false;
  var i;

  for (i = 0; i < CHECKS.length; i++) {
    var chk = CHECKS[i];
    var res;
    try { res = chk.run(); }
    catch (e) { res = { status: 'fail', detail: 'threw: ' + e }; }
    SCLOG(res.status.toUpperCase() + '  ' + chk.name +
      (res.detail ? '  — ' + res.detail : ''));
    if (res.status === 'fail' && chk.critical) criticalFail = true;
    if (res.status !== 'pass') anyWarn = true;
    if (!groups[chk.group]) { groups[chk.group] = []; order.push(chk.group); }
    groups[chk.group].push({ chk: chk, res: res });
  }

  for (i = 0; i < order.length; i++) {
    var g = order[i];
    var h = document.createElement('h2');
    h.textContent = g;
    report.appendChild(h);
    var items = groups[g];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<div class="badge ' + it.res.status + '">' + it.res.status.toUpperCase() + '</div>' +
        '<div><div class="name">' + it.chk.name + '</div>' +
        '<div class="detail">' + it.res.detail + '</div>' +
        '<div class="gates">gates: ' + it.chk.gates + '</div></div>';
      report.appendChild(row);
    }
  }

  var v = document.getElementById('verdict');
  if (criticalFail) {
    v.className = 'v-fail';
    v.textContent = '✗ A critical API is missing — the web app cannot run here as-is.';
  } else if (anyWarn) {
    v.className = 'v-warn';
    v.textContent = '✓ Core path works. Some optional features missing — runs, degraded.';
  } else {
    v.className = 'v-ok';
    v.textContent = '✓ Everything the web app needs is here.';
  }
  SCLOG('checks complete: ' + (criticalFail ? 'CRITICAL FAIL' : (anyWarn ? 'OK with warnings' : 'all pass')));
})();
