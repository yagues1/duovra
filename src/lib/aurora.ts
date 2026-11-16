/**
 * Aurora dinámica 2.0 del fondo (WebGL 2 con fallback WebGL 1, un shader de pantalla completa).
 *
 * Capas, de lejos a cerca: nebulosa profunda (violeta/azul, casi inmóvil), cortina principal
 * cian/turquesa con pliegues, cortina violeta alta, cinta de luz baja tras el compositor y
 * filamentos finos. Cada capa se mueve a un ritmo distinto (paralaje) y las cortinas se
 * sombrean según su pendiente, así que se leen como láminas de luz con volumen.
 *
 * Óptica: el shader dibuja las superficies de cristal que recibe (`GlassSource`) con la óptica
 * compartida de src/lib/glass/shader.ts (refracción, volumen, Fresnel, especular y sombra), igual
 * que Dot Matrix Flow. `sample` lee la luz final para los reflejos CSS. La aurora no importa nada
 * de los componentes; Background.tsx hace la conexión.
 *
 * Decisiones de rendimiento (WebView2):
 * - Se renderiza a una fracción de la resolución CSS y se escala: la aurora es difusa por
 *   naturaleza, así que no se pierde detalle y el coste por fotograma es mínimo.
 * - Fotogramas limitados (30/24 fps según intensidad) y movimiento lento: el material de cristal
 *   que hay encima recompone su desenfoque solo cuando cambia el fondo.
 * - Pase por columnas: los términos que solo dependen de x y del tiempo (26 de las 46 llamadas
 *   a noise() por píxel) se calculan una vez por columna en una textura flotante W × 3. Salida
 *   idéntica; sin texturas flotantes renderizables se calcula todo por píxel.
 * - Pausa total con la ventana oculta y ritmo muy bajo sin foco. En intensidad reducida o sin
 *   animaciones se dibuja un único fotograma estático.
 * - El shader y los buffers se crean una vez; React solo cambia el ritmo (`setFps`).
 * - El muestreo de luz se hace como mucho tres veces por segundo, con lectura diferida en WebGL 2.
 * - Si el sistema pierde el contexto WebGL, al restaurarse se recrean todos los recursos y la
 *   animación continúa donde estaba.
 */
import type { BackgroundRenderer, GlassSource } from './background';
import { glassFunctions, glassLight, glassUniforms } from './glass/shader';

const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

/** Shader de la aurora. Con `#define COLUMN_PASS` compila el pase por columnas. */
const frag = (maxGlass: number) => `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform vec2 uView;
uniform float uTime;
uniform float uGain;
uniform vec3 uK1a, uK1b, uK2a, uK2b, uK3;
uniform vec3 uPointer;
${glassUniforms(maxGlass)}
// Términos por columna precalculados (ver COLUMN_PASS) y si se usan.
uniform highp sampler2D uCol;
uniform float uUseCol;

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

/* Reflejo del entorno en el canto del cristal: la luz media de la paleta. */
vec3 glassEnv(vec2 p, vec2 n, float x){
  return vec3(0.05, 0.08, 0.15) + (uK1b * 0.5 + uK2a * 0.5) * 0.2 * uGain;
}
${glassFunctions(maxGlass)}

/* Centros de las cortinas (función de x y t) para poder derivar su pendiente. */
float fold1(float x, float t){ return fbm2(vec2(x * 2.4 + t * 0.018, t * 0.011)) - 0.5; }
float fold2(float x, float t){ return fbm2(vec2(x * 1.9 - t * 0.014, 5.0 + t * 0.009)) - 0.5; }
float centre1(float x, float t, float qx, float fold){
  return 0.13 + 0.38 * x + 0.07 * sin(x * 3.2 + t * 0.07) + 0.10 * (qx - 0.5) + 0.075 * fold;
}
float centre2(float x, float t, float qy, float fold){
  return 0.80 - 0.20 * x + 0.06 * sin(x * 2.4 - t * 0.055 + 1.3) + 0.08 * (qy - 0.5) + 0.06 * fold;
}

/*
 * Términos que solo dependen de x y del tiempo: pliegues de las dos cortinas (en x y x ± 0.01 para
 * la pendiente), las dos láminas de seda con su pendiente y el velo diagonal. Son 26 de las 46
 * llamadas a noise() por píxel y valen lo mismo en toda una columna, así que se calculan una vez
 * por columna (COLUMN_PASS, textura W × 3 en coma flotante) con exactamente las mismas funciones.
 */
void columnTerms(float x, float t, out vec4 a, out vec4 b, out vec4 c){
  a = vec4(fold1(x, t), fold1(x + 0.01, t), fold1(x - 0.01, t), fold2(x, t));
  b = vec4(fold2(x + 0.01, t), fold2(x - 0.01, t), ribbon1(x, t), (ribbon1(x + 0.01, t) - ribbon1(x - 0.01, t)) / 0.02);
  c = vec4(ribbon2(x, t), -(ribbon2(x + 0.01, t) - ribbon2(x - 0.01, t)) / 0.02, fbm2(vec2(x * 3.0, t * 0.02)), 0.0);
}

#ifdef COLUMN_PASS
void main(){
  vec4 a, b, c;
  columnTerms(vUv.x, uTime, a, b, c);
  float row = floor(gl_FragCoord.y);
  gl_FragColor = row < 0.5 ? a : (row < 1.5 ? b : c);
}
#else

void main(){
  vec2 uv = vUv;
  vec2 css = vec2(uv.x, 1.0 - uv.y) * uView;

  // Cristal: el fondo se muestrea refractado dentro de cada superficie (src/lib/glass/shader.ts).
  vec2 cssPx = css;
  Glass glass = glassEval(css);
  bool moved = dot(glass.off, glass.off) > 0.0;
  if (moved) {
    css += glass.off;
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

  // Términos por columna: de la textura, salvo donde la lente de un panel desplaza x.
  vec4 ca = texture2D(uCol, vec2(vUv.x, 0.5 / 3.0));
  vec4 cb = texture2D(uCol, vec2(vUv.x, 1.5 / 3.0));
  vec4 cc = texture2D(uCol, vec2(vUv.x, 2.5 / 3.0));
  if (uUseCol < 0.5 || moved) columnTerms(x, t, ca, cb, cc);

  // 1 · Gran cortina cian/turquesa con pliegues; se sombrea según su pendiente (volumen).
  float c1 = centre1(x, t, q.x, ca.x) + 0.035 * near * (uPointer.y - 0.3);
  float s1 = (centre1(x + 0.01, t, q.x, ca.y) - centre1(x - 0.01, t, q.x, ca.z)) / 0.02;
  float shade1 = 0.62 + 0.38 * smoothstep(-0.6, 1.4, s1);
  float r1 = 0.55 + 0.45 * fbm(vec2(x * 16.0 + q.y * 2.0, t * 0.05));
  float a1 = curtain(uv.y - c1, 0.115, r1) * shade1;
  vec3 k1 = mix(uK1a, uK1b, smoothstep(0.05, 0.95, x + 0.12 * sin(t * 0.021)));

  // 2 · Cortina violeta alta, a la derecha (capa intermedia, ritmo distinto).
  float c2 = centre2(x, t, q.y, ca.w);
  float s2 = (centre2(x + 0.01, t, q.y, cb.x) - centre2(x - 0.01, t, q.y, cb.y)) / 0.02;
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
  float a4 = band(uv.y - c4, 0.16) * (0.4 + 0.6 * cc.z) * smoothstep(0.0, 0.3, x);
  vec3 k4 = mix(uK3, uK2a, 0.45);

  // 5 · Láminas de seda: dos cintas de luz grandes, cian (sube desde abajo a la izquierda) y
  //     violeta (baja desde arriba a la derecha). Dan las curvas largas y la profundidad.
  float y1 = cb.z;
  float sl1 = cb.w;
  float l1 = sheet(uv.y - y1, 0.13, sl1) * smoothstep(-0.05, 0.25, x);
  float y2 = cc.x;
  float sl2 = cc.y;
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

  // Control de picos: compresión suave de las luces altas. Las zonas tenues casi no cambian
  // (volumen y color intactos) y los máximos ya no deslumbran detrás del cristal.
  float peak = max(aur.r, max(aur.g, aur.b));
  aur *= 1.0 / (1.0 + 0.62 * peak);
  col += aur;

  // Viñeta, tono suave y tramado contra bandas.
  col *= 1.0 - 0.36 * smoothstep(0.55, 1.25, length((uv - 0.5) * vec2(1.1, 1.0)) * 1.4);
  col = 1.0 - exp(-col * 1.25);
  vec3 outside = glassShadow(col, glass);
  col = glassShade(col, outside, glass, cssPx);
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
#endif`;


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

export interface Aurora extends BackgroundRenderer {
  setLook(look: AuroraLook): void;
}

export interface AuroraOptions {
  /** Desactiva el pase por columnas (solo para verificar que la salida es idéntica). */
  columnPass?: boolean;
}

/** GLSL ES 1.0 → 3.0: mismas operaciones y precisión, solo cambia la sintaxis de entrada/salida. */
const vertSource = (gl2: boolean) =>
  gl2 ? '#version 300 es\n' + VERT.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out') : VERT;
const fragSource = (src: string, gl2: boolean, column: boolean) => {
  const define = column ? '#define COLUMN_PASS\n' : '';
  if (!gl2) return define + src;
  return '#version 300 es\n' + define + 'out highp vec4 color;\n' +
    src.replace(/\bvarying\b/g, 'in').replace(/\bgl_FragColor\b/g, 'color').replace(/\btexture2D\(/g, 'texture(');
};

/** Recursos de GPU: se crean al empezar y se vuelven a crear si se restaura el contexto. */
interface Gpu {
  prog: WebGLProgram;
  shaders: WebGLShader[];
  buf: WebGLBuffer | null;
  pack: WebGLBuffer | null;
  u: Record<'res' | 'view' | 'time' | 'gain' | 'pointer' | 'g0' | 'g1' | 'g2' | 'gn' | 'gk' | 'light' | 'spec' | 'useCol', WebGLUniformLocation | null>;
  k: (WebGLUniformLocation | null)[];
  col: { prog: WebGLProgram; tex: WebGLTexture | null; fbo: WebGLFramebuffer | null; time: WebGLUniformLocation | null } | null;
}

export function createAurora(canvas: HTMLCanvasElement, glass: GlassSource, opts: AuroraOptions = {}): Aurora | null {
  const options: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false };
  const gl2 = canvas.getContext('webgl2', options);
  const gl: WebGLRenderingContext | WebGL2RenderingContext | null = gl2 ?? canvas.getContext('webgl', options);
  if (!gl) return null;
  // WebGL 1 garantiza pocos uniformes de fragmento: menos superficies.
  const maxGlass = gl2 ? Math.min(12, glass.max) : 4;
  const FRAG = frag(maxGlass);

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Aurora: el shader no compiló', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const link = (column: boolean) => {
    const vs = compile(gl.VERTEX_SHADER, vertSource(!!gl2));
    const fs = compile(gl.FRAGMENT_SHADER, fragSource(FRAG, !!gl2, column));
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    // Los dos programas comparten el triángulo de pantalla completa en el atributo 0.
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    return { prog, shaders: [vs, fs] };
  };
  /** Texturas flotantes renderizables (necesarias para el pase por columnas). */
  const floatTargets = () =>
    opts.columnPass !== false &&
    (gl2 ? !!gl2.getExtension('EXT_color_buffer_float') : !!(gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float')));

  const build = (): Gpu | null => {
    const main = link(false);
    if (!main) return null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const col = floatTargets() ? link(true) : null;
    gl.useProgram(main.prog);
    const loc = (n: string) => gl.getUniformLocation(main.prog, n);
    gl.uniform1i(loc('uCol'), 0);
    const g: Gpu = {
      prog: main.prog,
      shaders: [...main.shaders, ...(col?.shaders ?? [])],
      buf,
      // WebGL2 permite encolar las lecturas y recogerlas cuando la GPU ha terminado.
      // Un único buffer acotado a la última muestra; WebGL1 conserva la ruta síncrona.
      pack: gl2?.createBuffer() ?? null,
      u: {
        res: loc('uRes'), view: loc('uView'), time: loc('uTime'), gain: loc('uGain'), pointer: loc('uPointer'),
        g0: loc('uG0'), g1: loc('uG1'), g2: loc('uG2'), gn: loc('uGN'), gk: loc('uGK'), light: loc('uGLight'), spec: loc('uGSpec'), useCol: loc('uUseCol'),
      },
      k: ['uK1a', 'uK1b', 'uK2a', 'uK2b', 'uK3'].map(loc),
      col: col && { prog: col.prog, tex: gl.createTexture(), fbo: gl.createFramebuffer(), time: gl.getUniformLocation(col.prog, 'uTime') },
    };
    gl.uniform1f(g.u.useCol, 0);
    return g;
  };
  const release = (g: Gpu) => {
    gl.useProgram(null);
    if (g.col) {
      gl.deleteProgram(g.col.prog);
      gl.deleteTexture(g.col.tex);
      gl.deleteFramebuffer(g.col.fbo);
    }
    gl.deleteBuffer(g.buf);
    if (g.pack) gl.deleteBuffer(g.pack);
    gl.deleteProgram(g.prog);
    g.shaders.forEach((s) => gl.deleteShader(s));
  };

  let gpu = build();
  if (!gpu) return null;

  let look: AuroraLook = { palette: 'duovra', gain: 1, speed: 1 };
  let speed = 1;
  const applyLook = (next: AuroraLook) => {
    look = next;
    speed = Math.min(2, Math.max(0.25, next.speed));
    if (!gpu) return;
    const pal = AURORA_PALETTES[next.palette] ?? AURORA_PALETTES.duovra;
    pal.forEach((c, i) => gl.uniform3f(gpu!.k[i], c[0], c[1], c[2]));
    gl.uniform1f(gpu.u.gain, Math.min(1.3, Math.max(0.4, next.gain)));
  };
  applyLook(look);

  // Escala de render: suficiente para los filamentos y barata para la GPU.
  const SCALE = 0.5;
  const MAX_PIXELS = 1_100_000;
  let fps = 0;
  let time = 18; // punto de partida con las cortinas bien formadas
  let last = 0;
  let raf = 0;
  let lost = false;
  let destroyed = false;
  let redrawFrame = 0;
  let resizePending = false;
  let lensK = 0;
  /** Ancho de la textura de columnas (0 = por crear) y si el pase está operativo. */
  let colW = 0;
  let useCol = false;
  const g0 = new Float32Array(maxGlass * 4);
  const g1 = new Float32Array(maxGlass * 4);
  const g2 = new Float32Array(maxGlass * 4);
  let tint: [number, number, number] = [0.45, 0.88, 1];
  // Cursor: objetivo y valor suavizado (uv), con presencia 0–1.
  const ptr = { tx: 0.5, ty: 0.5, x: 0.5, y: 0.5, on: 0, ton: 0 };
  let pending: { points: [number, number][]; cb: (rgb: number[][]) => void } | null = null;
  const px = new Uint8Array(4);
  let packBytes = 0;
  let fence: WebGLSync | null = null;
  let sampleTimer = 0;
  let readback: { count: number; cb: (rgb: number[][]) => void } | null = null;
  const deliverSample = () => {
    const job = readback;
    readback = null;
    if (!gl2 || !job || !gpu?.pack) return;
    const bytes = new Uint8Array(job.count * 4);
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, gpu.pack);
    gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, bytes);
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
    job.cb(Array.from({ length: job.count }, (_, i) => [bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2]]));
  };
  const collect = () => {
    sampleTimer = 0;
    if (!gl2 || !fence || destroyed || lost) return;
    const status = gl2.clientWaitSync(fence, 0, 0);
    if (status === gl2.TIMEOUT_EXPIRED) {
      sampleTimer = window.setTimeout(collect, 16);
      return;
    }
    gl2.deleteSync(fence);
    fence = null;
    if (status !== gl2.WAIT_FAILED) deliverSample();
    else readback = null;
    if (pending && !raf) draw();
  };

  /** Textura W × 3 del pase por columnas, con el ancho del lienzo. */
  const allocColumns = (w: number) => {
    const col = gpu?.col;
    if (!col || colW === w) return;
    colW = w;
    gl.bindTexture(gl.TEXTURE_2D, col.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (gl2) gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA32F, w, 3, 0, gl2.RGBA, gl2.FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, 3, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, col.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, col.tex, 0);
    useCol = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(gpu!.prog);
    gl.uniform1f(gpu!.u.useCol, useCol ? 1 : 0);
  };

  const resize = (force = false) => {
    let w = Math.max(1, Math.round(window.innerWidth * SCALE));
    let h = Math.max(1, Math.round(window.innerHeight * SCALE));
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    if (k < 1) {
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    if (force || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    allocColumns(w);
  };

  const draw = () => {
    const g = gpu;
    if (lost || destroyed || !g) return;
    if (useCol && g.col) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.col.fbo);
      gl.viewport(0, 0, colW, 3);
      gl.useProgram(g.col.prog);
      gl.uniform1f(g.col.time, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(g.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g.col.tex);
    }
    gl.uniform2f(g.u.res, canvas.width, canvas.height);
    gl.uniform2f(g.u.view, window.innerWidth, window.innerHeight);
    gl.uniform1f(g.u.time, time);
    gl.uniform3f(g.u.pointer, ptr.x, ptr.y, ptr.on);
    gl.uniform1f(g.u.gk, lensK);
    if (lensK > 0) {
      const n = glass.read(g0, g1, g2, maxGlass);
      gl.uniform4fv(g.u.g0, g0);
      gl.uniform4fv(g.u.g1, g1);
      gl.uniform4fv(g.u.g2, g2);
      gl.uniform1f(g.u.gn, n);
      const L = glassLight({ x: ptr.x * window.innerWidth, y: (1 - ptr.y) * window.innerHeight, on: ptr.on > 0.5 ? 1 : 0 }, window.innerWidth, window.innerHeight);
      gl.uniform3f(g.u.light, L[0], L[1], L[2]);
      gl.uniform3f(g.u.spec, 0.86 + tint[0] * 0.14, 0.88 + tint[1] * 0.12, 0.92 + tint[2] * 0.08);
    } else gl.uniform1f(g.u.gn, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Muestreo de luz ambiental: inmediatamente tras dibujar, antes de presentar el buffer.
    if (pending && !fence) {
      const { points, cb } = pending;
      pending = null;
      const sx = canvas.width / window.innerWidth;
      const sy = canvas.height / window.innerHeight;
      if (gl2 && g.pack) {
        gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, g.pack);
        if (packBytes < points.length * 4) {
          packBytes = points.length * 4;
          gl2.bufferData(gl2.PIXEL_PACK_BUFFER, packBytes, gl2.STREAM_READ);
        }
      }
      const out = points.map(([x, y], i) => {
        const cx = Math.min(canvas.width - 1, Math.max(0, Math.round(x * sx)));
        const cy = Math.min(canvas.height - 1, Math.max(0, Math.round(canvas.height - 1 - y * sy)));
        if (gl2 && g.pack) gl2.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, i * 4);
        else gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      });
      if (gl2 && g.pack) {
        fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
        gl2.flush();
        readback = { count: points.length, cb };
        if (fence) sampleTimer = window.setTimeout(collect, 16);
        else deliverSample(); // Sin señal disponible, conserva la lectura síncrona original.
      } else cb(out);
    }
  };

  const effectiveFps = () => (destroyed || lost || document.hidden ? 0 : document.hasFocus() ? fps : Math.min(fps, 6));

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
    resizePending ||= withResize;
    if (redrawQueued || destroyed) return;
    redrawQueued = true;
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = 0;
      redrawQueued = false;
      if (destroyed) return;
      if (resizePending) { resize(); resizePending = false; }
      if (!raf) {
        draw();
        // Superficies en movimiento con la aurora quieta: se sigue dibujando mientras se mueven.
        if (lensK > 0 && glass.tracking()) redraw();
      }
    });
  };
  const onResize = () => redraw(true);
  const onWake = () => schedule();
  const onLost = (e: Event) => {
    // preventDefault indica que queremos el contexto de vuelta (webglcontextrestored).
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.clearTimeout(sampleTimer);
    sampleTimer = 0;
    // Los objetos del contexto perdido ya no son válidos: no se borran, se olvidan.
    gpu = null;
    fence = null;
    readback = null;
    pending = null;
    packBytes = 0;
    colW = 0;
    useCol = false;
  };
  const onRestored = () => {
    if (destroyed) return;
    lost = false;
    gpu = build();
    if (!gpu) {
      console.warn('Aurora: no se pudo recrear tras restaurar el contexto WebGL');
      return;
    }
    applyLook(look);
    resize(true);
    draw();
    schedule();
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('focus', onWake);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const unsubscribeLenses = glass.subscribe(() => {
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
    setLook(next) {
      applyLook(next);
      if (!raf) draw();
    },
    setLens(k) {
      lensK = Math.max(0, Math.min(1.5, k));
      if (!raf) redraw();
    },
    setTint(rgb) {
      tint = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
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
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (redrawFrame) cancelAnimationFrame(redrawFrame);
      window.clearTimeout(sampleTimer);
      pending = null;
      readback = null;
      if (fence) gl2?.deleteSync(fence);
      fence = null;
      if (gpu && !lost) release(gpu);
      gpu = null;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      unsubscribeLenses();
      // Sin loseContext(): con StrictMode el mismo lienzo se reutiliza al volver a montar.
    },
  };
}
