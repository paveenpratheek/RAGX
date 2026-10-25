/* ter-manager's wallpaper as this page's ground, the way GitX carries it in,
 * so RAGX stands on the same picture as the rest of the window.
 *
 * ter-manager paints it as its own body background, and this page is served
 * from the same origin, so it is read straight off the parent - read only.
 * The host's message API has no wallpaper method, and nothing behind a frame
 * shows through it, so copying the picture in is the only way to see it
 * (t-1ae77e7643).
 * Without one, or opened on its own, plugin.css paints a colour mesh mixed
 * from the palette instead.
 *
 * The picture goes straight onto body, never through a custom property:
 * Chrome drops a custom property over about 2 MB, and a wallpaper data URL
 * is easily that. It is set only when it changes, for the same reason.
 */
let paper = null;
let size = null;

function host() {
  try { return window.parent && window.parent !== window ? window.parent : null; } catch (_) { return null; }
}

/* Continue the host's picture rather than re-fitting it: ter-manager covers
 * ITS window, so the same cover arithmetic is done against the host window and
 * shifted by where this frame sits - the frame shows exactly the part of the
 * picture behind it. Opened on its own, plain cover is right. */
function place() {
  const b = document.body.style;
  const h = host();
  let rect = null;
  try { rect = h && window.frameElement ? window.frameElement.getBoundingClientRect() : null; } catch (_) { rect = null; }
  if (!paper || !size || !rect || !h.innerWidth || !h.innerHeight) { b.backgroundSize = ''; b.backgroundPosition = ''; return; }
  const scale = Math.max(h.innerWidth / size.w, h.innerHeight / size.h);
  const w = size.w * scale, ht = size.h * scale;
  b.backgroundSize = `${w.toFixed(1)}px ${ht.toFixed(1)}px`;
  b.backgroundPosition = `${((h.innerWidth - w) / 2 - rect.left).toFixed(1)}px ${((h.innerHeight - ht) / 2 - rect.top).toFixed(1)}px`;
}

function measure(p) {
  const src = /^url\(\s*"?(.*?)"?\s*\)$/.exec(p);
  if (!src) return;
  const img = new Image();
  img.onload = () => { if (paper === p) { size = { w: img.naturalWidth, h: img.naturalHeight }; place(); } };
  img.src = src[1];
}

function sync() {
  let next = null;
  try {
    const h = host();
    if (h) {
      const body = h.document.body;
      const img = body.style.backgroundImage || getComputedStyle(body).backgroundImage;
      if (img && img.indexOf('url(') === 0) next = img;
    }
  } catch (_) { /* another origin, or no host: the mesh stands in */ }
  const root = document.documentElement;
  if (next !== paper) {
    paper = next;
    size = null;
    if (paper) {
      document.body.style.backgroundImage = paper;
      root.setAttribute('data-wallpaper', '');
      // Whatever the reason a picture will not paint, the mesh beats a blank page.
      if (getComputedStyle(document.body).backgroundImage === 'none') {
        document.body.style.backgroundImage = '';
        root.removeAttribute('data-wallpaper');
        paper = null;
      } else measure(paper);
    } else {
      document.body.style.backgroundImage = '';
      root.removeAttribute('data-wallpaper');
    }
  }
  place();
}

export function followWallpaper() {
  sync();
  let frame = 0;
  const again = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
  // The frame moves and resizes with the host window and its sidebar; the picture follows.
  window.addEventListener('resize', again);
  window.addEventListener('focus', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  if (window.ResizeObserver) new ResizeObserver(again).observe(document.documentElement);
  // Changed in ter-manager's Settings: it rewrites its body's style and stores the picture.
  window.addEventListener('storage', (e) => { if (e.key === 'termanager.wallpaper') sync(); });
  const h = host();
  try {
    if (h) {
      h.addEventListener('resize', again);
      if (window.MutationObserver) new MutationObserver(sync).observe(h.document.body, { attributes: true, attributeFilter: ['style'] });
    }
  } catch (_) { /* not hosted */ }
}
