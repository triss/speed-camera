export function coverMap({
  videoWidth,
  videoHeight,
  drawWidth,
  drawHeight,
  mirror = false,
}) {
  const vw = videoWidth || 16;
  const vh = videoHeight || 9;
  const dw = drawWidth || 0;
  const dh = drawHeight || 0;
  const scale = Math.max(dw / vw, dh / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { ox: (dw - w) / 2, oy: (dh - h) / 2, w, h, mir: mirror };
}

export function screenToFramePoint(sx, sy, map) {
  let x = (sx - map.ox) / map.w;
  if (map.mir) x = 1 - x;
  return { x, y: (sy - map.oy) / map.h };
}

export function frameToScreenPoint(point, map) {
  const fx = map.mir ? 1 - point.x : point.x;
  return { x: map.ox + fx * map.w, y: map.oy + point.y * map.h };
}

export function createCoverMapper({ video, overlay, getMirror = () => false }) {
  const currentMap = () => coverMap({
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    drawWidth: overlay.clientWidth,
    drawHeight: overlay.clientHeight,
    mirror: getMirror(),
  });

  return {
    coverMap: currentMap,
    screenToFrame: (sx, sy) => screenToFramePoint(sx, sy, currentMap()),
    frameToScreen: (point) => frameToScreenPoint(point, currentMap()),
  };
}
