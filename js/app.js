// Wiring: audio -> both simulations -> render. All client side, no server.

import { AudioEngine } from './audio.js';
import { ChladniView } from './chladni.js';
import { FaradayView } from './faraday.js';
import { FaithfulView } from './faithful-view.js';

const $ = id => document.getElementById(id);

const audio = new AudioEngine();
let chladni = null;
let faraday = null;
let faithful = null;
let engine = 'rapido';

const elStage = $('stage');
const elStatus = $('audio-status');
const elLock = $('lock-status');
const roA = $('ro-chladni');
const roB = $('ro-faraday');
const specCv = $('cv-spectrum');
const specCtx = specCv.getContext('2d');

let view = 'split';

function fail(msg) {
  elStatus.textContent = msg;
  elStatus.classList.add('error');
}

try {
  chladni = new ChladniView($('cv-chladni'));
} catch (e) {
  fail('Chladni: ' + e.message);
  console.error(e);
}
try {
  faraday = new FaradayView($('cv-faraday'));
} catch (e) {
  fail('Faraday: ' + e.message);
  console.error(e);
}

// The faithful solver is expensive in memory and shaders: it is built the first time
// it is asked for, not at startup.
function enableFaithful() {
  if (faithful) return true;
  try {
    faithful = new FaithfulView($('cv-faithful'));
    return true;
  } catch (e) {
    fail('Faithful water: ' + e.message);
    console.error(e);
    return false;
  }
}

// ---------- audio sources ----------

// ---------- simple / expert mode ----------

const MODE_KEY = 'vibracion:experto';

const isExpert = () => document.body.dataset.mode === 'expert';

function setExpert(on) {
  document.body.dataset.mode = on ? 'expert' : 'simple';
  $('btn-mode').textContent = on ? 'Simple mode' : 'Expert mode';
  $('btn-mode').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(MODE_KEY, on ? '1' : '0'); } catch (_) {}
}

$('btn-mode').onclick = () => setExpert(!isExpert());

let savedMode = '0';
try { savedMode = localStorage.getItem(MODE_KEY) ?? '0'; } catch (_) {}
setExpert(savedMode === '1');

// ---------- demo tracks ----------

for (const btn of document.querySelectorAll('button.demo')) {
  btn.onclick = async () => {
    elStatus.classList.remove('error');
    elStatus.textContent = `Cargando ${btn.dataset.label}…`;
    document.querySelectorAll('button.demo').forEach(b => b.classList.toggle('on', b === btn));
    try {
      await audio.loadUrl(btn.dataset.track, btn.dataset.label);
      $('btn-play').disabled = false;
      $('btn-stop').disabled = false;
      $('tone-row').hidden = true;
      hideBowl();
      audio.play();
    } catch (e) {
      btn.classList.remove('on');
      fail('Could not load track: ' + e.message);
    }
  };
}

$('btn-file').onclick = () => $('file-input').click();

$('file-input').onchange = async ev => {
  const file = ev.target.files[0];
  if (!file) return;
  elStatus.classList.remove('error');
  elStatus.textContent = 'Decoding…';
  try {
    const dur = await audio.loadFile(file);
    $('btn-play').disabled = false;
    $('btn-stop').disabled = false;
    $('tone-row').hidden = true;
    hideBowl();
    elStatus.textContent = `${file.name} · ${dur.toFixed(1)} s. Press Play.`;
    audio.play();
  } catch (e) {
    fail('Could not decode file: ' + e.message);
  }
};

$('btn-play').onclick = () => { audio.play(); syncStatus(); };
$('btn-stop').onclick = () => { audio.stop(); syncStatus(); };

$('btn-mic').onclick = async () => {
  elStatus.classList.remove('error');
  try {
    await audio.useMic();
    $('tone-row').hidden = true;
    hideBowl();
    $('btn-stop').disabled = false;
    syncStatus();
  } catch (e) {
    fail('Microphone denied or unavailable: ' + e.message);
  }
};

// The bowl is the source that shows off both simulations best: its partials are
// inharmonic and sustained, so they excite unrelated eigenmodes and the Faraday
// pattern has time to grow without the frequency slipping away.
$('btn-bowl').onclick = () => {
  elStatus.classList.remove('error');
  audio.useBowl(Number($('s-bowl').value));
  $('bowl-row').hidden = false;
  $('btn-strike').hidden = false;
  $('tone-row').hidden = true;
  document.querySelectorAll('button.demo').forEach(b => b.classList.remove('on'));
  $('btn-stop').disabled = false;
  syncStatus();
  showPartials();
};

$('btn-strike').onclick = () => audio.strikeBowl();

function hideBowl() {
  $('bowl-row').hidden = true;
  $('btn-strike').hidden = true;
  $('bowl-info').hidden = true;
}

function showPartials() {
  if (!audio.bowl) return;
  const p = audio.bowl.partials();
  const info = $('bowl-info');
  info.hidden = false;
  info.textContent = 'Inharmonic partials: '
    + p.map(x => `${x.hz.toFixed(0)}`).join(' · ') + ' Hz'
    + `\nFundamental beat: ${p[0].beatHz.toFixed(2)} Hz`;
}

$('btn-tone').onclick = () => {
  elStatus.classList.remove('error');
  audio.useTone(Number($('s-tone').value));
  $('tone-row').hidden = false;
  hideBowl();
  $('btn-stop').disabled = false;
  syncStatus();
};

$('btn-sweep').onclick = () => {
  elStatus.classList.remove('error');
  audio.startSweep(50, 2000, 24);
  $('tone-row').hidden = true;
  hideBowl();
  $('btn-stop').disabled = false;
  syncStatus();
};

function syncStatus() {
  if (!elStatus.classList.contains('error')) elStatus.textContent = audio.describe();
}
audio.onstate = syncStatus;

// ---------- sliders ----------

function slider(id, outId, fmt, apply) {
  const el = $(id);
  const out = $(outId);
  const run = () => {
    const v = Number(el.value);
    out.textContent = fmt(v);
    apply(v);
  };
  el.addEventListener('input', run);
  run();
}

slider('s-vol', 'o-vol', v => v.toFixed(2), v => audio.setVolume(v));
slider('s-tone', 'o-tone', v => `${v} Hz`, v => { audio.setToneHz(v); syncStatus(); });
slider('s-bowl', 'o-bowl', v => `${v} Hz`, v => {
  audio.setBowlHz(v);
  if (audio.mode === 'bowl') { syncStatus(); showPartials(); }
});

slider('s-f0', 'o-f0', v => `${v} Hz`, v => { if (chladni) chladni.f0 = v; });
slider('s-q', 'o-q', v => `${v}`, v => { if (chladni) chladni.Q = v; });
slider('s-sigma', 'o-sigma', v => v.toFixed(3), v => { if (chladni) chladni.sigma = v; });
slider('s-persist', 'o-persist', v => v.toFixed(2), v => { if (chladni) chladni.persist = v; });

slider('s-omin', 'o-omin', v => v.toFixed(2), v => { if (faraday) faraday.omegaMin = v; });
slider('s-omax', 'o-omax', v => v.toFixed(2), v => { if (faraday) faraday.omegaMax = v; });
slider('s-sigmaS', 'o-sigmaS', v => v.toFixed(3), v => { if (faraday) faraday.S = v; });
slider('s-nu', 'o-nu', v => v.toFixed(3), v => { if (faraday) faraday.nu = v; });
slider('s-force', 'o-force', v => v.toFixed(3), v => { if (faraday) faraday.forceGain = v; });

// A single knob for anyone who does not want to touch physics. It writes into the
// expert sliders rather than bypassing them, so the two modes never disagree.
// Fine pattern = low f0 (a given note excites high-order modes) and high Omega (the
// subharmonic resonance selects a larger wavenumber).
function setSlider(id, value) {
  const el = $(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

const lerp = (a, b, t) => a + (b - a) * t;

slider('s-detail', 'o-detail',
  v => (v < 0.33 ? 'coarse' : v < 0.67 ? 'medium' : 'fine'),
  v => {
    setSlider('s-f0', Math.round(lerp(200, 35, v)));
    setSlider('s-omin', lerp(0.22, 0.45, v).toFixed(2));
    setSlider('s-omax', lerp(0.85, 2.60, v).toFixed(2));
  });

// ---------- segmented controls ----------

function segment(containerId, attr, apply) {
  const box = $(containerId);
  box.addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    [...box.querySelectorAll('button')].forEach(b => b.classList.toggle('on', b === btn));
    apply(btn.dataset[attr]);
  });
}

segment('view-seg', 'view', v => {
  view = v;
  elStage.classList.toggle('only-chladni', v === 'chladni');
  elStage.classList.toggle('only-faraday', v === 'faraday');
});
function markSeg(segId, attr, value) {
  for (const b of $(segId).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === value);
}

function setPowder(v) {
  if (chladni) chladni.powder = v;
  $('hint-chladni').textContent = v === 'node'
    ? 'powder gathers on the nodes'
    : 'heavy liquid gathers on the antinodes';
}

segment('shape-seg', 'shape', v => { chladni && chladni.setShape(v); markSeg('form-seg', 'form', v); });
segment('dish-seg', 'dish', v => { faraday && faraday.setShape(v); });
segment('powder-seg', 'powder', v => { setPowder(v); markSeg('matter-seg', 'powder', v); });

// Simple-mode controls: one shape for both simulations. In expert mode they can be
// set apart, and then these buttons mirror the Chladni plate.
segment('form-seg', 'form', v => {
  chladni && chladni.setShape(v);
  faraday && faraday.setShape(v);
  markSeg('shape-seg', 'shape', v);
  markSeg('dish-seg', 'dish', v);
});
segment('matter-seg', 'powder', v => { setPowder(v); markSeg('powder-seg', 'powder', v); });

// Two engines for panel B. The fast one is shallow water with a local saturation: it
// has speed to spare, but its coupling is isotropic and it only knows how to make
// stripes. The faithful one solves Zakharov with the real free-surface nonlinearity,
// which is why it can select squares in the capillary regime, like water and theory do.
segment('engine-seg', 'engine', v => {
  if (v === 'faithful' && !enableFaithful()) { markSeg('engine-seg', 'engine', 'rapido'); return; }
  engine = v;
  $('cv-faraday').hidden = v !== 'rapido';
  $('cv-faithful').hidden = v !== 'faithful';
  $('hint-faraday').textContent = v === 'rapido'
    ? 'shallow water, fast, always stripes'
    : 'Zakharov, real nonlinearity, selects squares';
});

$('btn-lock').onclick = () => {
  if (!faraday) return;
  faraday.locked = !faraday.locked;
  $('btn-lock').textContent = faraday.locked ? 'Unlock Ω' : 'Lock Ω to current peak';
  elLock.textContent = faraday.locked
    ? `Ω locked at ${faraday.omega.toFixed(2)}. Audio no longer moves it.`
    : 'Ω follows the live audio.';
};

$('btn-reset-f').onclick = () => { faraday && faraday.reset(); faithful && faithful.reset(); };

// ---------- fullscreen ----------

const BASE_RES = 700;

for (const btn of document.querySelectorAll('button.expand')) {
  btn.onclick = () => {
    const panel = $(btn.dataset.panel);
    if (document.fullscreenElement === panel) document.exitFullscreen();
    else panel.requestFullscreen?.().catch(e => fail('Fullscreen denied: ' + e.message));
  };
}

// The canvas scales through CSS, but its internal resolution does not. Without this a
// fullscreen recording comes out at thumbnail resolution and looks blurry.
document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement;
  const res = fs ? Math.min(1440, Math.max(720, window.screen.height || 1080)) : BASE_RES;
  for (const [panelId, canvasId] of [['panel-chladni', 'cv-chladni'], ['panel-faraday', 'cv-faraday']]) {
    if (fs && $(panelId) !== fs) continue;
    const cv = $(canvasId);
    cv.width = res;
    cv.height = res;
  }
});

$('btn-png-a').onclick = () => savePNG($('cv-chladni'), 'chladni');
$('btn-png-b').onclick = () => savePNG($('cv-faraday'), 'faraday');

function savePNG(canvas, name) {
  const a = document.createElement('a');
  a.download = `${name}-${Math.round(performance.now())}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

// ---------- spectrum ----------

function drawSpectrum() {
  const w = specCv.width, h = specCv.height;
  specCtx.fillStyle = '#0b0e14';
  specCtx.fillRect(0, 0, w, h);
  if (!audio.spectrum) {
    specCtx.fillStyle = '#5a6272';
    specCtx.font = '13px ui-monospace, monospace';
    specCtx.fillText('spectrum — no signal', 12, h / 2 + 4);
    return;
  }

  const fMin = 20, fMax = 6000;
  const lg = Math.log(fMax / fMin);
  const xOf = f => (Math.log(Math.max(fMin, f) / fMin) / lg) * w;

  // Octave grid.
  specCtx.strokeStyle = '#1b2029';
  specCtx.fillStyle = '#4a5262';
  specCtx.font = '9px ui-monospace, monospace';
  for (const f of [31.5, 63, 125, 250, 500, 1000, 2000, 4000]) {
    const x = xOf(f);
    specCtx.beginPath();
    specCtx.moveTo(x, 0); specCtx.lineTo(x, h);
    specCtx.stroke();
    specCtx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 3);
  }

  let peak = 1e-9;
  for (let i = 0; i < audio.bins; i++) if (audio.spectrum[i] > peak) peak = audio.spectrum[i];

  specCtx.fillStyle = '#4fd1c5';
  const iMin = Math.max(1, Math.floor(fMin / audio.binHz));
  const iMax = Math.min(audio.bins - 1, Math.ceil(fMax / audio.binHz));
  let prevX = -1;
  for (let i = iMin; i <= iMax; i++) {
    const x = Math.floor(xOf(i * audio.binHz));
    if (x === prevX) continue;
    prevX = x;
    const mag = audio.spectrum[i] / peak;
    const bh = Math.pow(mag, 0.45) * (h - 14);
    specCtx.fillRect(x, h - 14 - bh, 1, bh);
  }

  // Active plate eigenfrequencies.
  if (chladni && chladni.top.length) {
    for (const t of chladni.top) {
      const x = xOf(t.hz);
      specCtx.strokeStyle = `rgba(246,173,85,${0.25 + 0.6 * t.amp})`;
      specCtx.beginPath();
      specCtx.moveTo(x, 0); specCtx.lineTo(x, h - 14);
      specCtx.stroke();
    }
  }

  if (audio.dominantHz > fMin) {
    const x = xOf(audio.dominantHz);
    specCtx.strokeStyle = '#f56565';
    specCtx.beginPath();
    specCtx.moveTo(x, 0); specCtx.lineTo(x, h - 14);
    specCtx.stroke();
    specCtx.fillStyle = '#f56565';
    specCtx.fillText(`${audio.dominantHz.toFixed(0)} Hz`, Math.min(w - 46, x + 4), 11);
  }
}

// ---------- loop ----------

let frame = 0;

function loop() {
  requestAnimationFrame(loop);
  frame++;

  const live = audio.update();
  const hz = live ? audio.dominantHz : 0;
  const brightness = live ? audio.centroidHz : 0;
  const level = live ? audio.levelNorm : 0;

  if (chladni && view !== 'faraday') {
    chladni.excite(audio);
    chladni.render();
  }
  if (view !== 'chladni') {
    const water = engine === 'faithful' ? faithful : faraday;
    if (water) { water.setFromAudio(brightness, level); water.step(); water.render(); }
  }

  if (frame % 6 === 0) {
    drawSpectrum();
    if (chladni) roA.textContent = chladni.readout();
    const activeWater = engine === 'faithful' ? faithful : faraday;
    if (activeWater) roB.textContent = activeWater.readout(brightness);
    if (audio.sweep) syncStatus();
  }
}

loop();

// Console access, for poking at the parameters live.
window.vibracion = {
  audio,
  get chladni() { return chladni; },
  get faraday() { return faraday; },
  get faithful() { return faithful; },
  get engine() { return engine; },
};
