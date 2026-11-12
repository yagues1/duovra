/**
 * Aurora dinámica 2.0 del fondo (WebGL 1, un único shader de pantalla completa).
 *
 * Capas, de lejos a cerca: nebulosa profunda (violeta/azul, casi inmóvil), cortina principal
 * cian/turquesa con pliegues, cortina violeta alta, cinta de luz baja tras el compositor y
 * filamentos finos. Cada capa se mueve a un ritmo distinto (paralaje) y las cortinas se
 * sombrean según su pendiente, así que se leen como láminas de luz con volumen.
 *
 * Óptica (ver src/lib/optics.ts): el shader curva el fondo en los cantos de las superficies de
 * cristal registradas como lentes y muestrea la luz que hay cerca de cada `[data-env]`.
 *
 * Decisiones de rendimiento (WebView2):
 * - Se renderiza a una fracción de la resolución CSS y se escala: la aurora es difusa por
 *   naturaleza, así que no se pierde detalle y el coste por fotograma es mínimo.
 * - Fotogramas limitados (30/24 fps según intensidad) y movimiento lento: el material de cristal
 *   que hay encima recompone su desenfoque solo cuando cambia el fondo.
 * - Pausa total con la ventana oculta y ritmo muy bajo sin foco. En intensidad reducida o sin
 *   animaciones se dibuja un único fotograma estático.
 * - El shader y los buffers se crean una vez; React solo cambia el ritmo (`setFps`).
 * - El muestreo de luz (readPixels de 1 px) se hace como mucho tres veces por segundo.
 */
import { MAX_LENSES, onLensesChange, readLenses } from './optics';

const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform vec2 uView;
uniform float uTime;
uniform float uGain;
uniform vec3 uK1a, uK1b, uK2a, uK2b, uK3;
uniform vec3 uPointer;
uniform vec4 uLens[${MAX_LENSES}];
uniform float uLensR[${MAX_LENSES}];
uniform float uLensK;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return v;
}
float fbm2(vec2 p){ return 0.62 * noise(p) + 0.38 * noise(p * 2.07 + 3.1); }
float band(float d, float w){ return exp(-(d * d) / (w * w)); }

/*
 * Lámina de luz (seda): cresta nítida y velo que cuelga bajo ella y se apaga con la distancia.
 * La pendiente de la curva modula el brillo, así que la lámina parece girar sobre sí misma.
 */
float sheet(float d, float h, float slope){
  float crest = band(d, 0.0045);
  float veil = d < 0.0 ? exp(d / h) : exp(-d / (h * 0.12));
  float twist = 0.35 + 0.65 * smoothstep(-0.9, 1.6, slope);
  return (crest * 0.9 + veil * 0.55) * twist;
}
float ribbon1(float x, float t){
  return 0.1 + 0.42 * x + 0.075 * sin(x * 4.2 - t * 0.05 + 0.6) + 0.05 * (fbm2(vec2(x * 1.7, t * 0.012 + 9.0)) - 0.5);
}
float ribbon2(float x, float t){
  return 1.02 - 0.42 * x + 0.06 * sin(x * 3.4 + t * 0.042 + 2.1) + 0.05 * (fbm2(vec2(x * 1.5 + 4.0, -t * 0.01)) - 0.5);
}

/* Cortina de aurora: borde inferior luminoso, resplandor que sube y rayos verticales. */
float curtain(float d, float w, float rays){
  float edge = band(d, w * 0.35);
  float rise = smoothstep(-w * 0.3, w * 0.6, d) * exp(-max(d, 0.0) / (w * 1.15));
  return edge * 0.55 + rise * rays;
}

/* Rectángulo redondeado (px CSS, origen arriba a la izquierda): distancia con signo. */
float sdBox(vec2 p, vec4 r, float rad){
  vec2 c = r.xy + r.zw * 0.5;
  vec2 q = abs(p - c) - (r.zw * 0.5 - rad);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}

/* Centros de las cortinas (función de x y t) para poder derivar su pendiente. */
float centre1(float x, float t, float qx){
  float fold = fbm2(vec2(x * 2.4 + t * 0.018, t * 0.011)) - 0.5;
  return 0.13 + 0.38 * x + 0.07 * sin(x * 3.2 + t * 0.07) + 0.10 * (qx - 0.5) + 0.075 * fold;
}
float centre2(float x, float t, float qy){
  float fold = fbm2(vec2(x * 1.9 - t * 0.014, 5.0 + t * 0.009)) - 0.5;
  return 0.80 - 0.20 * x + 0.06 * sin(x * 2.4 - t * 0.055 + 1.3) + 0.08 * (qy - 0.5) + 0.06 * fold;
}

void main(){
  vec2 uv = vUv;
  vec2 css = vec2(uv.x, 1.0 - uv.y) * uView;

  // Lentes: en el canto de cada superficie de cristal el fondo se curva hacia dentro y la luz se
  // concentra, como en el borde grueso de una lámina de vidrio. Gradiente numérico de la SDF.
  float caustic = 0.0;
  if (uLensK > 0.0) {
    vec2 disp = vec2(0.0);
    for (int i = 0; i < ${MAX_LENSES}; i++) {
      vec4 r = uLens[i];
      if (r.z < 1.0) continue;
      float rad = min(uLensR[i], min(r.z, r.w) * 0.5);
      float d = sdBox(css, r, rad);
      const float BAND = 30.0;
      if (d < 0.0 && d > -BAND) {
        float e = 1.0;
        vec2 n = normalize(vec2(sdBox(css + vec2(e, 0.0), r, rad) - sdBox(css - vec2(e, 0.0), r, rad),
                                sdBox(css + vec2(0.0, e), r, rad) - sdBox(css - vec2(0.0, e), r, rad)) + 1e-5);
        float x = 1.0 + d / BAND;              // 1 en el canto, 0 hacia dentro
        float bend = 1.0 - sqrt(1.0 - x * x);  // perfil de bisel circular
        disp += n * bend * 26.0;
        caustic += smoothstep(0.55, 1.0, x) * (1.0 - smoothstep(0.96, 1.0, x));
      }
    }
    css -= disp * uLensK;
    uv = vec2(css.x / uView.x, 1.0 - css.y / uView.y);
  }

  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = uTime;
  float x = uv.x;

  // Cursor: atrae muy levemente las cortinas y templa la luz a su alrededor.
  vec2 pd = (uv - uPointer.xy) * vec2(asp, 1.0);
  float near = exp(-dot(pd, pd) / 0.09) * uPointer.z;

  // Base: azul abisal con volúmenes de luz suaves.
  vec3 col = mix(vec3(0.010, 0.022, 0.066), vec3(0.022, 0.044, 0.118), uv.y);
  col += vec3(0.05, 0.10, 0.27) * smoothstep(1.15, 0.0, length(p - vec2(asp * 0.86, 1.08)));
  col += vec3(0.01, 0.07, 0.13) * smoothstep(0.95, 0.0, length(p - vec2(0.05, -0.05)));

  // 0 · Nebulosa profunda: masas violeta y azul muy lentas (capa más lejana, casi sin paralaje).
  float neb = fbm(p * 1.15 + vec2(t * 0.006, -t * 0.004));
  float nebMask = smoothstep(0.42, 0.85, neb) * smoothstep(0.15, 0.75, uv.y);
  col += mix(uK2b, uK2a, neb) * nebMask * 0.085 * uGain;

  // Deformación lenta compartida (las ondas respiran juntas, sin saltos).
  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t * 0.020)), fbm(p * 0.9 + vec2(4.3, -t * 0.017)));

  // 1 · Gran cortina cian/turquesa con pliegues; se sombrea según su pendiente (volumen).
  float c1 = centre1(x, t, q.x) + 0.035 * near * (uPointer.y - 0.3);
  float s1 = (centre1(x + 0.01, t, q.x) - centre1(x - 0.01, t, q.x)) / 0.02;
  float shade1 = 0.62 + 0.38 * smoothstep(-0.6, 1.4, s1);
  float r1 = 0.55 + 0.45 * fbm(vec2(x * 16.0 + q.y * 2.0, t * 0.05));
  float a1 = curtain(uv.y - c1, 0.115, r1) * shade1;
  vec3 k1 = mix(uK1a, uK1b, smoothstep(0.05, 0.95, x + 0.12 * sin(t * 0.021)));

  // 2 · Cortina violeta alta, a la derecha (capa intermedia, ritmo distinto).
  float c2 = centre2(x, t, q.y);
  float s2 = (centre2(x + 0.01, t, q.y) - centre2(x - 0.01, t, q.y)) / 0.02;
  float shade2 = 0.6 + 0.4 * smoothstep(1.0, -1.0, s2);
  float r2 = 0.5 + 0.5 * fbm(vec2(x * 12.0 - q.x, t * 0.045 + 3.0));
  float a2 = curtain(uv.y - c2, 0.10, r2) * smoothstep(0.22, 0.85, x) * shade2;
  vec3 k2 = mix(uK2a, uK2b, smoothstep(0.2, 1.0, x + 0.1 * sin(t * 0.017 + 2.0)));

  // 3 · Cinta de luz baja, detrás del compositor (capa cercana, algo más rápida).
  float c3 = 0.05 + 0.05 * sin(x * 4.0 + t * 0.075) + 0.05 * (q.y - 0.5);
  float a3 = curtain(uv.y - c3, 0.09, 0.7) * smoothstep(0.0, 0.35, x) * smoothstep(1.0, 0.55, x);
  vec3 k3 = uK3;

  // 4 · Velo azul eléctrico que cruza en diagonal: une las capas y da profundidad media.
  float c4 = 0.42 + 0.30 * (x - 0.5) + 0.05 * sin(x * 2.0 + t * 0.03 + 4.0) + 0.06 * (q.x - 0.5);
  float a4 = band(uv.y - c4, 0.16) * (0.4 + 0.6 * fbm2(vec2(x * 3.0, t * 0.02))) * smoothstep(0.0, 0.3, x);
  vec3 k4 = mix(uK3, uK2a, 0.45);

  // 5 · Láminas de seda: dos cintas de luz grandes, cian (sube desde abajo a la izquierda) y
  //     violeta (baja desde arriba a la derecha). Dan las curvas largas y la profundidad.
  float y1 = ribbon1(x, t);
  float sl1 = (ribbon1(x + 0.01, t) - ribbon1(x - 0.01, t)) / 0.02;
  float l1 = sheet(uv.y - y1, 0.13, sl1) * smoothstep(-0.05, 0.25, x);
  float y2 = ribbon2(x, t);
  float sl2 = -(ribbon2(x + 0.01, t) - ribbon2(x - 0.01, t)) / 0.02;
  float l2 = sheet(y2 - uv.y, 0.1, sl2) * smoothstep(0.3, 0.75, x);
  vec3 kr1 = mix(uK1a, uK1b, smoothstep(0.0, 1.0, x));
  vec3 kr2 = mix(uK2b, uK2a, smoothstep(0.4, 1.0, x));

  // Filamentos: ondas transparentes nítidas que siguen las cortinas.
  float f1 = band(uv.y - c1 + 0.028, 0.0032) + 0.6 * band(uv.y - c1 + 0.062 + 0.01 * sin(x * 6.0 + t * 0.09), 0.0028);
  float f2 = band(uv.y - c2 - 0.03, 0.003) * smoothstep(0.35, 0.9, x);

  // Zona de lectura: columna central (chat y bienvenida). Más tranquila y con filamentos
  // atenuados para que ninguna onda nítida cruce el texto con intensidad.
  float calm = smoothstep(0.7, 0.0, length((uv - vec2(0.55, 0.54)) * vec2(1.55, 0.95)));
  float fCalm = 1.0 - 0.85 * calm;

  vec3 aur = k1 * a1 * 1.38 + k2 * a2 * 1.2 + k3 * a3 * 0.92 + k4 * a4 * 0.28;
  aur += (vec3(0.55, 0.92, 1.0) * f1 * 0.66 + vec3(0.72, 0.62, 1.0) * f2 * 0.52) * fCalm;
  // Las láminas se retiran casi del todo de la zona de lectura: ahí solo queda su velo.
  float sCalm = 1.0 - 0.88 * calm;
  aur += (kr1 * l1 * 0.95 + kr2 * l2 * 0.85) * sCalm;
  aur *= 1.0 - 0.62 * calm;
  aur *= uGain * (1.0 + 0.16 * near);

  // Cáustica de los cantos de cristal: la luz que atraviesa el bisel se concentra un poco.
  aur *= 1.0 + caustic * 0.7 * uLensK;

  // Control de picos: compresión suave de las luces altas. Las zonas tenues casi no cambian
  // (volumen y color intactos) y los máximos ya no deslumbran detrás del cristal.
  float peak = max(aur.r, max(aur.g, aur.b));
  aur *= 1.0 / (1.0 + 0.62 * peak);
  col += aur;

  // Viñeta, tono suave y tramado contra bandas.
  col *= 1.0 - 0.36 * smoothstep(0.55, 1.25, length((uv - 0.5) * vec2(1.1, 1.0)) * 1.4);
  col = 1.0 - exp(-col * 1.25);
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Paletas de la aurora: todas dentro de la gama azul, cian y violeta de Duovra. */
export const AURORA_PALETTES = {
  duovra: [[0.08, 0.78, 0.7], [0.2, 0.72, 1.0], [0.36, 0.3, 0.95], [0.58, 0.34, 1.0], [0.12, 0.5, 1.0]],
  glaciar: [[0.3, 0.85, 1.0], [0.55, 0.86, 1.0], [0.25, 0.55, 1.0], [0.42, 0.66, 1.0], [0.2, 0.6, 1.0]],
  nebulosa: [[0.3, 0.45, 1.0], [0.55, 0.4, 1.0], [0.7, 0.35, 1.0], [0.85, 0.42, 0.95], [0.4, 0.35, 0.95]],
  abisal: [[0.1, 0.45, 0.75], [0.15, 0.4, 0.85], [0.22, 0.25, 0.7], [0.3, 0.28, 0.8], [0.08, 0.35, 0.7]],
} as const satisfies Record<string, readonly (readonly [number, number, number])[]>;
export type AuroraPalette = keyof typeof AURORA_PALETTES;

export interface AuroraLook {
  palette: AuroraPalette;
  /** Intensidad luminosa (0.4–1.3). */
  gain: number;
  /** Multiplicador de velocidad del movimiento (0.25–2). */
  speed: number;
}

export interface Aurora {
  setFps(fps: number): void;
  setLook(look: AuroraLook): void;
  /** Fuerza de la lente en los cantos del cristal (0 = desactivada). */
  setLens(k: number): void;
  /** Cursor en px CSS; null lo retira. Solo influye mientras la aurora está animada. */
  setPointer(x: number | null, y?: number): void;
  /** Lee el color final del fondo en puntos (px CSS) tras el próximo fotograma. */
  sample(points: [number, number][], cb: (rgb: number[][]) => void): void;
  destroy(): void;
}

export function createAurora(canvas: HTMLCanvasElement): Aurora | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Aurora: el shader no compiló', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = u('uRes');
  const uView = u('uView');
  const uTime = u('uTime');
  const uGain = u('uGain');
  const uPointer = u('uPointer');
  const uLens = u('uLens');
  const uLensR = u('uLensR');
  const uLensK = u('uLensK');
  const uK = ['uK1a', 'uK1b', 'uK2a', 'uK2b', 'uK3'].map(u);
  let speed = 1;
  const applyLook = (look: AuroraLook) => {
    const pal = AURORA_PALETTES[look.palette] ?? AURORA_PALETTES.duovra;
    pal.forEach((c, i) => gl.uniform3f(uK[i], c[0], c[1], c[2]));
    gl.uniform1f(uGain, Math.min(1.3, Math.max(0.4, look.gain)));
    speed = Math.min(2, Math.max(0.25, look.speed));
  };
  applyLook({ palette: 'duovra', gain: 1, speed: 1 });

  // Escala de render: suficiente para los filamentos y barata para la GPU.
  const SCALE = 0.5;
  const MAX_PIXELS = 1_100_000;
  let fps = 0;
  let time = 18; // punto de partida con las cortinas bien formadas
  let last = 0;
  let raf = 0;
  let lost = false;
  let lensK = 0;
  let lensDirty = true;
  const lensRects = new Float32Array(MAX_LENSES * 4);
  const lensRadii = new Float32Array(MAX_LENSES);
  // Cursor: objetivo y valor suavizado (uv), con presencia 0–1.
  const ptr = { tx: 0.5, ty: 0.5, x: 0.5, y: 0.5, on: 0, ton: 0 };
  let pending: { points: [number, number][]; cb: (rgb: number[][]) => void } | null = null;
  const px = new Uint8Array(4);

  const resize = () => {
    let w = Math.max(1, Math.round(window.innerWidth * SCALE));
    let h = Math.max(1, Math.round(window.innerHeight * SCALE));
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    if (k < 1) {
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  const draw = () => {
    if (lost) return;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uView, window.innerWidth, window.innerHeight);
    gl.uniform1f(uTime, time);
    gl.uniform3f(uPointer, ptr.x, ptr.y, ptr.on);
    gl.uniform1f(uLensK, lensK);
    if (lensK > 0 && lensDirty) {
      lensDirty = false;
      readLenses(lensRects, lensRadii);
      gl.uniform4fv(uLens, lensRects);
      gl.uniform1fv(uLensR, lensRadii);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Muestreo de luz ambiental: inmediatamente tras dibujar, antes de presentar el buffer.
    if (pending) {
      const { points, cb } = pending;
      pending = null;
      const sx = canvas.width / window.innerWidth;
      const sy = canvas.height / window.innerHeight;
      const out = points.map(([x, y]) => {
        const cx = Math.min(canvas.width - 1, Math.max(0, Math.round(x * sx)));
        const cy = Math.min(canvas.height - 1, Math.max(0, Math.round(canvas.height - 1 - y * sy)));
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      });
      cb(out);
    }
  };

  const effectiveFps = () => (document.hidden ? 0 : document.hasFocus() ? fps : Math.min(fps, 6));

  const loop = (now: number) => {
    raf = 0;
    const target = effectiveFps();
    if (!target) return;
    const interval = 1000 / target;
    if (!last) last = now;
    const dt = now - last;
    if (dt >= interval - 2) {
      // Pasos acotados: al volver de una pausa no hay saltos.
      const step = Math.min(dt, 100) / 1000;
      time += step * speed;
      // Inercia del cursor: la luz lo sigue con retraso, nunca de golpe.
      const k = 1 - Math.exp(-step * 2.2);
      ptr.x += (ptr.tx - ptr.x) * k;
      ptr.y += (ptr.ty - ptr.y) * k;
      ptr.on += (ptr.ton - ptr.on) * k;
      last = now;
      draw();
    }
    raf = requestAnimationFrame(loop);
  };

  const schedule = () => {
    if (!raf && effectiveFps() > 0) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };

  let redrawQueued = false;
  const redraw = (withResize = false) => {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      if (withResize) resize();
      if (!raf) draw();
    });
  };
  const onResize = () => redraw(true);
  const onWake = () => schedule();
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('focus', onWake);
  canvas.addEventListener('webglcontextlost', onLost);
  onLensesChange(() => {
    lensDirty = true;
    if (lensK > 0) redraw();
  });

  resize();
  draw();

  return {
    setFps(next) {
      fps = next;
      if (fps > 0) schedule();
      else draw();
    },
    setLook(look) {
      applyLook(look);
      if (!raf) draw();
    },
    setLens(k) {
      lensK = Math.max(0, Math.min(1.5, k));
      lensDirty = true;
      if (!raf) redraw();
    },
    setPointer(x, y = 0) {
      if (x === null) {
        ptr.ton = 0;
        return;
      }
      ptr.tx = x / window.innerWidth;
      ptr.ty = 1 - y / window.innerHeight;
      ptr.ton = 1;
    },
    sample(points, cb) {
      pending = { points, cb };
      if (!raf) draw();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      canvas.removeEventListener('webglcontextlost', onLost);
      onLensesChange(null);
      // Sin loseContext(): con StrictMode el mismo lienzo se reutiliza al volver a montar.
    },
  };
}
