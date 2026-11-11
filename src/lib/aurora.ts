/**
 * Aurora dinámica del fondo (WebGL 1, un único shader de pantalla completa).
 *
 * Decisiones de rendimiento (WebView2):
 * - Se renderiza a una fracción de la resolución CSS y se escala: la aurora es difusa por
 *   naturaleza, así que no se pierde detalle y el coste por fotograma es mínimo.
 * - Fotogramas limitados (30/24 fps según intensidad) y movimiento lento: el material de cristal
 *   que hay encima recompone su desenfoque solo cuando cambia el fondo.
 * - Pausa total con la ventana oculta y ritmo muy bajo sin foco. En intensidad reducida o sin
 *   animaciones se dibuja un único fotograma estático.
 * - El shader y los buffers se crean una vez; React solo cambia el ritmo (`setFps`).
 */

const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uGain;
uniform vec3 uK1a, uK1b, uK2a, uK2b, uK3;

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
float band(float d, float w){ return exp(-(d * d) / (w * w)); }

/* Cortina de aurora: borde inferior luminoso, resplandor que sube y rayos verticales. */
float curtain(float d, float w, float rays){
  float edge = band(d, w * 0.35);
  float rise = smoothstep(-w * 0.3, w * 0.6, d) * exp(-max(d, 0.0) / (w * 1.15));
  return edge * 0.55 + rise * rays;
}

void main(){
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = uTime;
  float x = uv.x;

  // Base: azul abisal con volúmenes de luz suaves.
  vec3 col = mix(vec3(0.012, 0.027, 0.075), vec3(0.025, 0.05, 0.13), uv.y);
  col += vec3(0.05, 0.10, 0.27) * smoothstep(1.15, 0.0, length(p - vec2(asp * 0.86, 1.08)));
  col += vec3(0.01, 0.07, 0.13) * smoothstep(0.95, 0.0, length(p - vec2(0.05, -0.05)));

  // Deformación lenta compartida (las ondas respiran juntas, sin saltos).
  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t * 0.020)), fbm(p * 0.9 + vec2(4.3, -t * 0.017)));

  // 1 · Gran cortina cian/turquesa: de abajo a la izquierda hacia el centro derecho.
  float c1 = 0.14 + 0.38 * x + 0.07 * sin(x * 3.2 + t * 0.07) + 0.10 * (q.x - 0.5);
  float r1 = 0.55 + 0.45 * fbm(vec2(x * 16.0 + q.y * 2.0, t * 0.05));
  float a1 = curtain(uv.y - c1, 0.11, r1);
  vec3 k1 = mix(uK1a, uK1b, smoothstep(0.1, 0.9, x));

  // 2 · Cortina violeta alta, a la derecha.
  float c2 = 0.80 - 0.20 * x + 0.06 * sin(x * 2.4 - t * 0.055 + 1.3) + 0.08 * (q.y - 0.5);
  float r2 = 0.5 + 0.5 * fbm(vec2(x * 12.0 - q.x, t * 0.045 + 3.0));
  float a2 = curtain(uv.y - c2, 0.10, r2) * smoothstep(0.25, 0.85, x);
  vec3 k2 = mix(uK2a, uK2b, x);

  // 3 · Resplandor bajo, detrás del compositor.
  float c3 = 0.05 + 0.05 * sin(x * 4.0 + t * 0.06) + 0.05 * (q.y - 0.5);
  float a3 = curtain(uv.y - c3, 0.09, 0.7) * smoothstep(0.0, 0.35, x) * smoothstep(1.0, 0.55, x);
  vec3 k3 = uK3;

  // Filamentos: ondas transparentes nítidas que siguen la cortina principal.
  float f1 = band(uv.y - c1 + 0.028, 0.0035) + 0.6 * band(uv.y - c1 + 0.062 + 0.01 * sin(x * 6.0 + t * 0.09), 0.003);
  float f2 = band(uv.y - c2 - 0.03, 0.003) * smoothstep(0.35, 0.9, x);

  // Zona de lectura: columna central (chat y bienvenida). Más tranquila y con filamentos
  // atenuados para que ninguna onda nítida cruce el texto con intensidad.
  float calm = smoothstep(0.7, 0.0, length((uv - vec2(0.55, 0.54)) * vec2(1.55, 0.95)));
  float fCalm = 1.0 - 0.8 * calm;

  vec3 aur = k1 * a1 * 1.4 + k2 * a2 * 1.22 + k3 * a3 * 0.95;
  aur += (vec3(0.55, 0.92, 1.0) * f1 * 0.72 + vec3(0.72, 0.62, 1.0) * f2 * 0.58) * fCalm;
  aur *= 1.0 - 0.6 * calm;
  aur *= uGain;

  // Control de picos: compresión suave de las luces altas. Las zonas tenues casi no cambian
  // (volumen y color intactos) y los máximos ya no deslumbran detrás del cristal.
  float peak = max(aur.r, max(aur.g, aur.b));
  aur *= 1.0 / (1.0 + 0.6 * peak);
  col += aur;

  // Viñeta, tono suave y tramado contra bandas.
  col *= 1.0 - 0.35 * smoothstep(0.55, 1.25, length((uv - 0.5) * vec2(1.1, 1.0)) * 1.4);
  col = 1.0 - exp(-col * 1.25);
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Paletas de la aurora: todas dentro de la gama azul, cian y violeta de Duovra. */
export const AURORA_PALETTES = {
  duovra: [[0.08, 0.78, 0.7], [0.2, 0.72, 1.0], [0.36, 0.3, 0.95], [0.55, 0.36, 1.0], [0.12, 0.55, 0.95]],
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
  destroy(): void;
}

export function createAurora(canvas: HTMLCanvasElement): Aurora | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
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
  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const uGain = gl.getUniformLocation(prog, 'uGain');
  const uK = ['uK1a', 'uK1b', 'uK2a', 'uK2b', 'uK3'].map((n) => gl.getUniformLocation(prog, n));
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
    gl.uniform1f(uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      time += (Math.min(dt, 100) / 1000) * speed;
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

  let resizeQueued = false;
  const onResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
      draw();
    });
  };
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
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      canvas.removeEventListener('webglcontextlost', onLost);
      // Sin loseContext(): con StrictMode el mismo lienzo se reutiliza al volver a montar.
    },
  };
}
