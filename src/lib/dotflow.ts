/**
 * Dot Matrix Flow: fondo predeterminado de Duovra 0.5.1 (WebGL 2, dos pasadas a pantalla completa).
 *
 * Lenguaje visual (estudiado fotograma a fotograma en el vídeo de referencia):
 * - Matriz regular y densa de puntos cuadrados con esquinas suavizadas (paso de 8 px CSS) sobre
 *   un negro frío. En reposo es una cuadrícula oscura de puntos blancos, casi estática, con una
 *   variación de brillo muy amplia y fija para que no parezca plana.
 * - Las formas no se dibujan encima: salen de los propios puntos. Cada celda decide su estado con
 *   un tramado ordenado (Bayer 4 × 4), como un semitono: donde la intensidad es media, los
 *   puntos se encienden en damero; donde es alta, todos; y los bordes de cada forma se deshacen
 *   en puntos sueltos. Es la textura de las cintas violetas y de las nubes grises del vídeo.
 *
 * Comportamiento (0.5.1):
 * - Reposo: 0 fotogramas. El cursor no deja ondas ni estelas; solo inclina la luz del cristal.
 * - Clic: nace una onda del matiz elegido. Empieza como una mancha que se abre en anillo, se
 *   expande frenándose, se curva (el radio varía con el ángulo y el dominio se retuerce con ruido
 *   coherente), se rompe en arcos y cintas, empuja la matriz (onda de compresión que desplaza los
 *   puntos) y deja dentro una estela de semitono gris que se disuelve. Varias ondas se suman.
 * - Sin ondas activas, ni superficies moviéndose, el bucle se detiene.
 *
 * Arquitectura:
 * 1. Pase de campo (cols × filas, una celda por texel, MRT): intensidad neutra, intensidad del
 *    acento, crecimiento del punto y desplazamiento de la matriz. El ruido y las ondas se evalúan
 *    una vez por celda (~20 000 a 1440 × 900), no por píxel.
 * 2. Pase de puntos (resolución nativa): óptica del cristal (src/lib/glass/shader.ts), lectura del
 *    desplazamiento con filtrado lineal, celda, tramado y forma del punto. En el bisel del cristal
 *    se evalúan tres puntos (rojo, verde y azul desplazados: aberración cromática).
 *
 * Rendimiento: un único contexto WebGL 2, dos llamadas de dibujo por fotograma y solo mientras
 * haya algo que animar; sin lecturas de GPU (`sample` es analítica); pausa con la ventana oculta;
 * pérdida y restauración de contexto (el estado de las ondas vive en CPU).
 */
import type { BackgroundRenderer, GlassSource, ReadingSource } from './background';
import { glassFunctions, glassLight, glassUniforms } from './glass/shader';
import type { Reaction } from './hues';

/** Parámetros de la matriz. */
export const FLOW = {
  /** Paso de la matriz en px CSS (se ajusta a píxeles enteros del dispositivo). */
  pitch: 8,
  /** Ondas simultáneas como máximo (la más antigua cede su sitio). */
  maxWaves: 8,
  /** Desplazamiento máximo de un punto (px CSS), codificado en 8 bits. */
  dispRange: 6,
} as const;

export interface WavePreset {
  /** Velocidad inicial del frente (px CSS/s). */
  speed: number;
  /** Escala del ancho de la cinta y de su deformación. */
  band: number;
  /** Duración total (s). */
  duration: number;
  /** Presencia del color. */
  accent: number;
  /** Estela gris de semitono dentro de la onda. */
  wake: number;
  /** Empuje de la matriz (px CSS). */
  push: number;
  /** Brillo de los puntos encendidos. */
  bright: number;
}

/**
 * Sutil, Media y Viva cambian el carácter de la onda, no solo su opacidad: velocidad, grosor y
 * deformación de la cinta, presencia del matiz, estela, empuje y brillo, con el mismo lenguaje.
 */
export const WAVE_PRESETS: Record<Reaction, WavePreset> = {
  subtle: { speed: 400, band: 0.78, duration: 3.2, accent: 0.7, wake: 0.32, push: 1.8, bright: 0.88 },
  normal: { speed: 470, band: 1, duration: 3.8, accent: 0.95, wake: 0.6, push: 2.8, bright: 1 },
  vivid: { speed: 540, band: 1.25, duration: 4.4, accent: 1.15, wake: 0.9, push: 4, bright: 1.12 },
};

/** Radio del frente de una onda a los `age` segundos (frena hacia el final). */
export function waveRadius(age: number, p: WavePreset) {
  const a = Math.max(0, Math.min(age, p.duration));
  return p.speed * a * (1 - 0.22 * (a / p.duration));
}

/** Paso de la matriz en píxeles del dispositivo y tamaño de la textura del campo. */
export function gridFor(cssW: number, cssH: number, dpr: number, pitch: number = FLOW.pitch) {
  const pitchDev = Math.max(4, Math.round(pitch * dpr));
  const cols = Math.ceil((cssW * dpr) / pitchDev) + 2;
  const rows = Math.ceil((cssH * dpr) / pitchDev) + 2;
  return { pitchDev, cols, rows, origin: -1 };
}

/** Ondas vivas: descarta las que ya han terminado y limita el número. */
export function pruneWaves<T extends { t0: number }>(waves: T[], now: number, duration: number, max: number = FLOW.maxWaves) {
  const alive = waves.filter((w) => now - w.t0 < duration);
  return alive.length > max ? alive.slice(alive.length - max) : alive;
}

const MAXG = 12;
const MAXW = FLOW.maxWaves;

const VS = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const NOISE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
  return v / 0.875;
}`;

/* ------------------------------ Pase 1: campo por celda ------------------------------ */
const FIELD_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 oField;
layout(location = 1) out vec4 oDisp;
uniform float uPitch;
uniform float uDpr;
uniform float uOrigin;
uniform float uTime;
uniform vec4 uW[${MAXW}];
uniform float uWN;
uniform vec4 uP1;   // velocidad, banda, duración, acento
uniform vec4 uP2;   // estela, empuje, brillo, -
uniform vec4 uRead; // columna de lectura (w = 0: ninguna)
${NOISE}

void main(){
  vec2 cell = floor(gl_FragCoord.xy) + uOrigin;
  vec2 pc = (cell + 0.5) * uPitch / uDpr;       // centro de la celda, px CSS

  // Reposo: variación amplia y fija del brillo (sin tiempo).
  float base = smoothstep(0.25, 0.85, fbm3(pc / 420.0 + 3.7));

  float acc = 0.0;
  float wake = 0.0;
  float grow = 0.0;
  vec2 disp = vec2(0.0);
  float T = uP1.z;
  for (int i = 0; i < ${MAXW}; i++) {
    if (float(i) >= uWN) break;
    vec4 w = uW[i];
    float a = uTime - w.z;
    if (a < 0.0 || a > T) continue;
    float seed = w.w * 97.0;
    float k = a / T;
    vec2 v = pc - w.xy;
    float dist = length(v);
    vec2 dir = v / (dist + 1e-3);
    float r = uP1.x * a * (1.0 - 0.22 * k);
    // El dominio se retuerce cada vez más: el anillo se convierte en cintas curvas.
    vec2 warp = (vec2(vnoise(pc / 210.0 + seed), vnoise(pc / 210.0 + seed + 17.3)) - 0.5) * (24.0 + 120.0 * a) * uP1.y;
    float dw = length(v + warp);
    // Radio dependiente del ángulo (ruido sobre el círculo unidad: sin costuras).
    float ang = vnoise(dir * 1.6 + seed + a * 0.35);
    float amp = (8.0 + 52.0 * a) * uP1.y;
    float d1 = dw - (r + (ang - 0.5) * 2.0 * amp);
    // Cinta ancha (≈ 60–90 px, como en la referencia), con el grosor modulado por el ángulo.
    float wd = (24.0 + 22.0 * a) * uP1.y * (0.7 + 0.6 * vnoise(dir * 3.1 - seed));
    float core = exp(-(d1 * d1) / (wd * wd));
    // Con la edad el anillo se rompe en arcos.
    float arcs = mix(1.0, smoothstep(0.22, 0.62, vnoise(dir * 2.4 + seed * 1.7 - a * 0.25)), smoothstep(0.25, 1.3, a));
    float fade = smoothstep(0.0, 0.06, a) * (1.0 - smoothstep(T * 0.5, T, a));
    // Segundo anillo, más fino, que nace después y va por dentro.
    float ang2 = vnoise(dir * 2.1 - seed + a * 0.5);
    float d2 = length(v + warp * 1.35) - (r * 0.6 + (ang2 - 0.5) * 1.6 * amp);
    float w2 = wd * 0.5;
    float inner = exp(-(d2 * d2) / (w2 * w2)) * smoothstep(0.2, 0.6, a) * 0.55;
    // Nacimiento: una mancha que se abre.
    float blob = exp(-(dist * dist) / (1600.0 * uP1.y * uP1.y)) * (1.0 - smoothstep(0.0, 0.35, a));
    acc += (core * arcs * 1.35 + inner * arcs + blob * 1.2) * fade;
    // Estela gris dentro del frente: semitono que se disuelve antes que la cinta.
    float behind = smoothstep(r + 8.0, r - 120.0, dw) * smoothstep(0.0, r * 0.5 + 1.0, dw);
    float neb = fbm3(pc / 92.0 + seed + vec2(a * 0.18, -a * 0.11));
    wake += behind * smoothstep(0.42, 0.82, neb) * fade * (1.0 - smoothstep(0.3 * T, 0.8 * T, a));
    grow += core * arcs * fade;
    // Onda de compresión: los puntos se apartan al paso del frente y vuelven.
    float z = d1 / wd;
    disp += dir * z * exp(-z * z) * 2.3 * fade * uP2.y;
  }
  acc = (1.0 - exp(-2.2 * acc)) * uP1.w;
  wake = (1.0 - exp(-1.8 * wake)) * uP2.x;

  // Detrás de la columna de lectura, todo se calma (el texto manda).
  if (uRead.z > 0.0) {
    vec2 h = uRead.zw * 0.5;
    vec2 q = abs(pc - uRead.xy - h) - h;
    float dr = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float m = 1.0 - smoothstep(-30.0, 50.0, dr);
    // La onda es una respuesta deliberada a un clic: se atenúa poco; la estela y el reposo, más.
    acc *= 1.0 - 0.22 * m;
    wake *= 1.0 - 0.55 * m;
    base *= 1.0 - 0.45 * m;
    disp *= 1.0 - 0.3 * m;
  }

  oField = vec4(wake, acc, clamp(grow, 0.0, 1.0), 0.0);
  disp = clamp(disp, vec2(-${FLOW.dispRange.toFixed(1)}), vec2(${FLOW.dispRange.toFixed(1)}));
  oDisp = vec4(disp / ${(2 * FLOW.dispRange).toFixed(1)} + 0.5, base, 1.0);
}`;

/* ------------------------------ Pase 2: puntos y cristal ------------------------------ */
const DOT_FS = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D uField;   // NEAREST
uniform sampler2D uDisp;    // LINEAR
uniform vec2 uRes;          // px del dispositivo
uniform float uDpr;
uniform float uPitch;
uniform float uOrigin;
uniform vec2 uGrid;
uniform vec3 uHue;
uniform vec3 uDeep;
uniform float uBright;
${glassUniforms(MAXG)}

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float bayer(ivec2 c){ return (BAYER[(c.y & 3) * 4 + (c.x & 3)] + 0.5) / 16.0; }

ivec2 cellOf(vec2 css){
  vec2 cell = floor(css * uDpr / uPitch);
  return clamp(ivec2(cell - uOrigin), ivec2(0), ivec2(uGrid) - 1);
}
vec2 dispUv(vec2 css){ return (css * uDpr / uPitch - uOrigin) / uGrid; }

// Capa de puntos en el punto q (px CSS): rgb premultiplicado y alfa.
vec4 dotsAt(vec2 q, float base, float frost){
  vec2 dq = q * uDpr;
  vec2 cell = floor(dq / uPitch);
  vec2 l = dq - (cell + 0.5) * uPitch;
  ivec2 ci = clamp(ivec2(cell - uOrigin), ivec2(0), ivec2(uGrid) - 1);
  vec4 f = texelFetch(uField, ci, 0);
  float bay = bayer(ivec2(cell));
  float onA = smoothstep(bay - 0.09, bay + 0.09, f.g);
  float onN = smoothstep(bay - 0.11, bay + 0.11, f.r);
  float lA = onA * (0.5 + 0.5 * f.g);
  float lN = onN * (0.45 + 0.55 * f.r) * (1.0 - lA);
  float lit = max(lA, lN);
  // En la cinta los puntos crecen hasta ~55 % del paso (la cinta se lee como un bloque denso,
  // como en la referencia); en la estela gris, menos.
  float hw = uDpr * (0.82 + 0.62 * lN + 1.05 * lA + 0.35 * f.b);
  float alpha = (0.17 + 0.13 * base) * (1.0 - lit) + 0.66 * lN + lA;
  float r = hw * 0.4;
  vec2 dd = abs(l) - hw + r;
  float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0) - r;
  float soft = 0.5 + frost * uDpr;
  float cov = smoothstep(soft, -soft, sd);
  vec3 neutral = vec3(0.80, 0.85, 0.93);
  // Cuerpo de la cinta con el tono profundo (saturado) del matiz y núcleo con su tono claro; los
  // puntos neutros siguen blancos y grises.
  vec3 deep = clamp(mix(vec3(dot(uDeep, vec3(0.3, 0.59, 0.11))), uDeep, 1.25), 0.0, 1.0);
  vec3 accent = mix(deep * 1.12, uHue, smoothstep(0.35, 0.95, f.g));
  vec3 c = mix(neutral, accent, lA / (lA + lN + 1e-3));
  float a = alpha * cov;
  return vec4(c * a * uBright, a);
}

vec3 glassEnv(vec2 p, vec2 n, float x){
  // El canto refleja lo que hay fuera de la pieza: si una onda pasa cerca, el borde se tiñe.
  vec2 e = p + n * (16.0 + 34.0 * (1.0 - x));
  vec4 f = texelFetch(uField, cellOf(e), 0);
  return vec3(0.075, 0.085, 0.11) + uHue * f.g * 0.85 + vec3(0.55, 0.6, 0.68) * f.r * 0.35;
}

${glassFunctions(MAXG)}

void main(){
  vec2 dev = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = dev / uDpr;
  Glass g = glassEval(p);
  vec2 q = p + g.off;
  vec4 dd = texture(uDisp, dispUv(q));
  q -= (dd.xy - 0.5) * ${(2 * FLOW.dispRange).toFixed(1)};
  float base = dd.z;
  float frost = g.frost * 0.9;
  vec3 bgc = vec3(0.014, 0.016, 0.022) + vec3(0.006, 0.008, 0.014) * (1.0 - length((p / max(uRes / uDpr, vec2(1.0)) - 0.5) * vec2(1.2, 1.0)));
  vec3 dots;
  if (g.bevel > 0.02 && g.disp > 0.0) {
    // Aberración cromática solo en el bisel.
    vec2 ca = g.off * 0.07 * g.disp;
    vec4 dr = dotsAt(q + ca, base, frost);
    vec4 dg = dotsAt(q, base, frost);
    vec4 db = dotsAt(q - ca, base, frost);
    dots = vec3(dr.r, dg.g, db.b);
  } else {
    dots = dotsAt(q, base, frost).rgb;
  }
  vec3 col = bgc + dots;
  vec3 outside = glassShadow(col, g);
  col = glassShade(col, outside, g, p);
  // Tramado contra bandas en los degradados oscuros.
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  color = vec4(col, 1.0);
}`;

export interface DotFlow extends BackgroundRenderer {
  setReaction(r: Reaction): void;
  /** Emite una onda en (x, y) px CSS. Sin efecto en modo estático. */
  pulse(x: number, y: number): void;
}

interface Gpu {
  field: WebGLProgram;
  dots: WebGLProgram;
  shaders: WebGLShader[];
  buf: WebGLBuffer | null;
  vao: WebGLVertexArrayObject | null;
  texField: WebGLTexture | null;
  texDisp: WebGLTexture | null;
  fbo: WebGLFramebuffer | null;
  uf: Record<string, WebGLUniformLocation | null>;
  ud: Record<string, WebGLUniformLocation | null>;
}

interface Wave {
  x: number;
  y: number;
  t0: number;
  seed: number;
}

export function createDotFlow(canvas: HTMLCanvasElement, sources: { glass: GlassSource; reading: ReadingSource }): DotFlow | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Dot Matrix Flow: el shader no compiló', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const link = (fsSrc: string, shaders: WebGLShader[]) => {
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    shaders.push(vs, fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('Dot Matrix Flow: el programa no enlazó', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  };
  const uniforms = (prog: WebGLProgram, names: string[]) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));

  const build = (): Gpu | null => {
    const shaders: WebGLShader[] = [];
    const field = link(FIELD_FS, shaders);
    const dots = link(DOT_FS, shaders);
    if (!field || !dots) {
      if (field) gl.deleteProgram(field);
      if (dots) gl.deleteProgram(dots);
      shaders.forEach((s) => gl.deleteShader(s));
      return null;
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (filter: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const g: Gpu = {
      field, dots, shaders, buf, vao,
      texField: tex(gl.NEAREST),
      texDisp: tex(gl.LINEAR),
      fbo: gl.createFramebuffer(),
      uf: uniforms(field, ['uPitch', 'uDpr', 'uOrigin', 'uTime', 'uW', 'uWN', 'uP1', 'uP2', 'uRead']),
      ud: uniforms(dots, ['uField', 'uDisp', 'uRes', 'uDpr', 'uPitch', 'uOrigin', 'uGrid', 'uHue', 'uDeep', 'uBright', 'uG0', 'uG1', 'uG2', 'uGN', 'uGK', 'uGLight', 'uGSpec']),
    };
    gl.useProgram(dots);
    gl.uniform1i(g.ud.uField, 0);
    gl.uniform1i(g.ud.uDisp, 1);
    return g;
  };
  const release = (g: Gpu) => {
    gl.useProgram(null);
    gl.bindVertexArray(null);
    gl.deleteTexture(g.texField);
    gl.deleteTexture(g.texDisp);
    gl.deleteFramebuffer(g.fbo);
    gl.deleteBuffer(g.buf);
    gl.deleteVertexArray(g.vao);
    gl.deleteProgram(g.field);
    gl.deleteProgram(g.dots);
    g.shaders.forEach((s) => gl.deleteShader(s));
  };

  let gpu = build();
  if (!gpu) return null;

  const start = performance.now();
  const clock = () => (performance.now() - start) / 1000;
  let live = true;
  let preset: WavePreset = WAVE_PRESETS.normal;
  let waves: Wave[] = [];
  let lensK = 0;
  let tint: [number, number, number] = [0.45, 0.88, 1];
  let deep: [number, number, number] = [0.3, 0.55, 1];
  let raf = 0;
  let lost = false;
  let destroyed = false;
  let frozenAt = 0;
  let grid = { pitchDev: 8, cols: 0, rows: 0, origin: -1 };
  let dpr = 1;
  let seedN = 0;
  const ptr = { x: 0, y: 0, on: 0 };
  const light: [number, number, number] = [-0.52, -0.72, 0.62];
  const g0 = new Float32Array(MAXG * 4);
  const g1 = new Float32Array(MAXG * 4);
  const g2 = new Float32Array(MAXG * 4);
  const wbuf = new Float32Array(MAXW * 4);

  const resize = (force = false) => {
    const g = gpu;
    if (!g) return;
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    const next = gridFor(window.innerWidth, window.innerHeight, dpr);
    if (force || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (force || next.cols !== grid.cols || next.rows !== grid.rows || next.pitchDev !== grid.pitchDev) {
      grid = next;
      for (const t of [g.texField, g.texDisp]) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, grid.cols, grid.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.texField, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g.texDisp, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  };

  /** Imagen fija representativa (fondo animado apagado): dos ondas detenidas a media vida. */
  const frozenWaves = (t: number): Wave[] => [
    { x: window.innerWidth * 0.7, y: window.innerHeight * 0.64, t0: t - preset.duration * 0.34, seed: 0.37 },
    { x: window.innerWidth * 0.3, y: window.innerHeight * 0.26, t0: t - preset.duration * 0.52, seed: 0.81 },
  ];

  /** Dibuja un fotograma. Devuelve si hay que seguir animando. */
  const draw = () => {
    const g = gpu;
    if (!g || lost || destroyed) return false;
    resize();
    const t = live ? clock() : frozenAt;
    if (live) waves = pruneWaves(waves, t, preset.duration);
    const list = live ? waves : frozenWaves(t);

    // Luz del cristal: se acerca con suavidad a la dirección que marca el cursor.
    const target = glassLight(ptr, window.innerWidth, window.innerHeight);
    let easing = false;
    for (let i = 0; i < 3; i++) {
      const dl = target[i] - light[i];
      light[i] += dl * 0.22;
      if (Math.abs(dl) > 0.004) easing = true;
    }

    gl.bindVertexArray(g.vao);
    // Pase 1: campo por celda.
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
    gl.viewport(0, 0, grid.cols, grid.rows);
    gl.useProgram(g.field);
    gl.uniform1f(g.uf.uPitch, grid.pitchDev);
    gl.uniform1f(g.uf.uDpr, dpr);
    gl.uniform1f(g.uf.uOrigin, grid.origin);
    gl.uniform1f(g.uf.uTime, t);
    wbuf.fill(0);
    list.forEach((w, i) => wbuf.set([w.x, w.y, w.t0, w.seed], i * 4));
    gl.uniform4fv(g.uf.uW, wbuf);
    gl.uniform1f(g.uf.uWN, list.length);
    gl.uniform4f(g.uf.uP1, preset.speed, preset.band, preset.duration, preset.accent);
    gl.uniform4f(g.uf.uP2, preset.wake, preset.push, preset.bright, 0);
    const rd = sources.reading.read();
    if (rd) gl.uniform4f(g.uf.uRead, rd[0], rd[1], rd[2], rd[3]);
    else gl.uniform4f(g.uf.uRead, 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pase 2: puntos y cristal a resolución nativa.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(g.dots);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.texField);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.texDisp);
    gl.uniform2f(g.ud.uRes, canvas.width, canvas.height);
    gl.uniform1f(g.ud.uDpr, dpr);
    gl.uniform1f(g.ud.uPitch, grid.pitchDev);
    gl.uniform1f(g.ud.uOrigin, grid.origin);
    gl.uniform2f(g.ud.uGrid, grid.cols, grid.rows);
    gl.uniform3f(g.ud.uHue, tint[0], tint[1], tint[2]);
    gl.uniform3f(g.ud.uDeep, deep[0], deep[1], deep[2]);
    gl.uniform1f(g.ud.uBright, preset.bright);
    const n = lensK > 0 ? sources.glass.read(g0, g1, g2, MAXG) : 0;
    gl.uniform4fv(g.ud.uG0, g0);
    gl.uniform4fv(g.ud.uG1, g1);
    gl.uniform4fv(g.ud.uG2, g2);
    gl.uniform1f(g.ud.uGN, n);
    gl.uniform1f(g.ud.uGK, lensK);
    gl.uniform3f(g.ud.uGLight, light[0], light[1], light[2]);
    gl.uniform3f(g.ud.uGSpec, 0.86 + tint[0] * 0.14, 0.88 + tint[1] * 0.12, 0.92 + tint[2] * 0.08);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    return (live && waves.length > 0) || (lensK > 0 && sources.glass.tracking()) || easing;
  };

  const frame = () => {
    raf = 0;
    if (destroyed || lost || document.hidden) return;
    if (draw()) raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (!raf && !destroyed && !lost && !document.hidden) raf = requestAnimationFrame(frame);
  };

  const onResize = () => wake();
  const onVisible = () => wake();
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    gpu = null;
    grid = { pitchDev: 8, cols: 0, rows: 0, origin: -1 };
  };
  const onRestored = () => {
    if (destroyed) return;
    lost = false;
    gpu = build();
    if (!gpu) {
      console.warn('Dot Matrix Flow: no se pudo recrear tras restaurar el contexto WebGL');
      return;
    }
    resize(true);
    wake();
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisible);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const offGlass = sources.glass.subscribe(wake);
  const offReading = sources.reading.subscribe(wake);

  resize(true);
  draw();

  return {
    setFps(fps) {
      const next = fps > 0;
      if (next === live) return wake();
      live = next;
      if (!live) {
        frozenAt = clock();
        waves = [];
      }
      wake();
    },
    setReaction(r) {
      preset = WAVE_PRESETS[r] ?? WAVE_PRESETS.normal;
      wake();
    },
    setLens(k) {
      lensK = Math.max(0, Math.min(1.5, k));
      wake();
    },
    setTint(rgb, rgbDeep) {
      tint = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
      const d = rgbDeep ?? rgb;
      deep = [d[0] / 255, d[1] / 255, d[2] / 255];
      wake();
    },
    setPointer(x, y = 0) {
      if (x === null) {
        if (!ptr.on) return;
        ptr.on = 0;
        if (lensK > 0) wake();
        return;
      }
      ptr.x = x;
      ptr.y = y;
      ptr.on = 1;
      // Solo repinta cerca de una superficie de cristal: su luz sigue al cursor.
      if (lensK > 0 && sources.glass.near(x, y, 140)) wake();
    },
    pulse(x, y) {
      if (!live || destroyed) return;
      const t = clock();
      // Semilla cuasialeatoria (proporción áurea): cada onda se deforma de manera distinta.
      seedN = (seedN + 0.618034) % 1;
      waves = pruneWaves([...waves, { x, y, t0: t, seed: seedN }], t, preset.duration);
      wake();
    },
    sample(points, cb) {
      // Analítica: el fondo es casi negro y frío; el cristal no necesita leer la GPU.
      cb(points.map(() => [24, 27, 34]));
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (gpu && !lost) release(gpu);
      gpu = null;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      offGlass();
      offReading();
    },
  };
}
