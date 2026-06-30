/* Live camera test. Promise-based ES5, loaded after checks.js. A parse issue
   here cannot stop the report above, because each classic script compiles
   independently and log.js has already installed window.onerror. */
(function () {
  var stream = null, rafId = 0;
  var video = document.getElementById('cam');
  var out = document.getElementById('camResult');
  var startBtn = document.getElementById('startCam');
  var stopBtn = document.getElementById('stopCam');

  function measureFps(done) {
    var frames = 0;
    var start = performance.now();
    var useRvfc = window.HTMLVideoElement &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    function tick() {
      frames++;
      var elapsed = performance.now() - start;
      if (elapsed >= 2000) { done(frames / (elapsed / 1000)); }
      else if (useRvfc) { video.requestVideoFrameCallback(tick); }
      else { rafId = requestAnimationFrame(tick); }
    }
    if (useRvfc) { video.requestVideoFrameCallback(tick); }
    else { rafId = requestAnimationFrame(tick); }
  }

  function startCam() {
    out.textContent = '';
    SCLOG('camera: requesting permission…');
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      SCLOG('camera: getUserMedia unavailable');
      out.textContent = 'getUserMedia not available on this browser.';
      return;
    }
    navigator.mediaDevices.getUserMedia(
      { video: { facingMode: { ideal: 'environment' } }, audio: false }
    ).then(function (s) {
      stream = s;
      video.srcObject = stream;
      video.style.display = 'block';
      SCLOG('camera: stream acquired');
      startBtn.disabled = true;
      stopBtn.disabled = false;
      var p = video.play();
      if (p && p.catch) { p.catch(function () {}); }
      var track = stream.getVideoTracks()[0];
      var st = track.getSettings ? track.getSettings() : {};
      SCLOG('camera: ' + video.videoWidth + 'x' + video.videoHeight +
        ' — measuring fps…');
      measureFps(function (fps) {
        SCLOG('camera: measured ' + fps.toFixed(1) + ' fps');
        out.textContent =
          'resolution: ' + video.videoWidth + 'x' + video.videoHeight + '\n' +
          'facing:     ' + (st.facingMode || '?') + '\n' +
          'reported:   ' + (st.frameRate ? st.frameRate.toFixed(1) + ' fps' : 'n/a') + '\n' +
          'measured:   ' + fps.toFixed(1) + ' fps over ~2s\n\n' +
          (fps >= 12 ? '→ adequate frame rate for speed estimation.'
                     : '→ low frame rate; fast objects will suffer.');
      });
    }).catch(function (e) {
      SCLOG('camera FAILED: ' + e.name + ' — ' + e.message);
      out.textContent = 'camera failed: ' + e.name + ' — ' + e.message;
    });
  }

  function stopCam() {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) {
      var ts = stream.getTracks();
      for (var i = 0; i < ts.length; i++) ts[i].stop();
    }
    stream = null;
    video.style.display = 'none';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    SCLOG('camera: stopped');
  }

  startBtn.addEventListener('click', startCam);
  stopBtn.addEventListener('click', stopCam);
  SCLOG('camera test ready');
})();
