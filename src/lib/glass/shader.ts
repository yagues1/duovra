/**
 * Óptica Liquid Glass compartida por los dos fondos (GLSL compatible con ES 1.0 y 3.0).
 *
 * El fondo dibuja el cristal de las superficies registradas (src/lib/glass/surfaces.ts). Por
 * cada píxel:
 *
 * 1. Geometría. Rectángulo redondeado (SDF analítica). El canto es un bisel convexo de perfil
 *    «squircle», h(x) = (1 − (1 − x)⁴)^¼ con x = distancia al borde / ancho del bisel: plano en la
 *    placa y casi vertical en el borde. La normal sale del gradiente de una SDF con esquinas
 *    redondeadas al menos tanto como el bisel, así que es continua en las esquinas (sin costura
 *    diagonal). Las cápsulas que se mueven se estiran en la dirección de su velocidad y se
 *    estrechan en la perpendicular (volumen constante): el material, nunca el texto.
 * 2. Refracción. Inclinación de la superficie α = atan(h′·grosor). Con Snell (n = 1,5) el rayo se
 *    desvía α − asin(sin α / n): nada en la placa y cada vez más hacia el borde. El canto curvo
 *    recoge luz de más allá del borde: el fondo se muestrea desplazado hacia fuera con un perfil de
 *    esa forma, d(s) = 0,55·B·(1 − s/B)^2,5. La imagen se comprime hacia el filo (las filas de
 *    puntos convergen y, en las esquinas, giran) y nunca se pliega: ampliarla estiraría cada punto
 *    en rayas, que en una matriz de puntos se leen como ruido.
 * 3. Dispersión. En el bisel, rojo y azul se desplazan un ±7 % distinto (aberración cromática
 *    solo donde hay curvatura).
 * 4. Luz. Fresnel de Schlick (F0 = 0,04) con el reflejo del entorno que da cada fondo
 *    (`glassEnv`), especular Blinn-Phong de una luz arriba a la izquierda que el cursor inclina,
 *    un segundo brillo en la cara opuesta (la luz que sale por el canto contrario), sombreado
 *    lambertiano del canto (volumen) y una cáustica en el interior del bisel del lado opuesto
 *    a la luz.
 * 5. Placa. Transmisión según el tipo (el fondo se ve atenuado, no tapado), tinte azul muy
 *    oscuro y un esmerilado que el fondo aplica a su manera (los puntos se ablandan; la aurora
 *    ya es difusa). Fuera, una sombra de contacto suave separa la pieza del fondo.
 *
 * Varias superficies anidadas (la cápsula sobre el compositor) suman su refracción y multiplican
 * su transmisión; la sombra y los brillos son los de la superficie superior.
 */

export const glassUniforms = (max: number) => `
uniform vec4 uG0[${max}];
uniform vec4 uG1[${max}];
uniform vec4 uG2[${max}];
uniform float uGN;
uniform float uGK;
uniform vec3 uGLight;
uniform vec3 uGSpec;
`;

/** Requiere definir antes `vec3 glassEnv(vec2 css, vec2 n, float x)`. */
export const glassFunctions = (max: number) => `
struct Glass {
  vec2 off;      // desplazamiento de muestreo (px CSS, hacia fuera en el canto)
  float cov;     // cobertura (antialias del borde)
  float trans;   // transmisión acumulada
  float frost;   // esmerilado (px de suavizado extra)
  float bevel;   // 1 en el canto, 0 en la placa
  float x;       // posición en el bisel (0 borde → 1 placa)
  vec2 n;        // normal hacia fuera
  float tilt;    // inclinación de la superficie
  float disp;    // dispersión (0–1)
  float shadow;  // sombra de contacto fuera
  float kind;
};

float gBox(vec2 q, vec2 h, float r){
  vec2 d = abs(q) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

Glass glassEval(vec2 p){
  Glass g;
  g.off = vec2(0.0); g.cov = 0.0; g.trans = 1.0; g.frost = 0.0; g.bevel = 0.0; g.x = 1.0;
  g.n = vec2(0.0, -1.0); g.tilt = 0.0; g.disp = 0.0; g.shadow = 0.0; g.kind = -1.0;
  if (uGK <= 0.0) return g;
  for (int i = 0; i < ${max}; i++) {
    if (float(i) >= uGN) break;
    vec4 r = uG0[i];
    vec4 a = uG1[i];
    vec4 b = uG2[i];
    vec2 hs = r.zw * 0.5;
    vec2 q = p - (r.xy + hs);
    if (abs(q.x) > hs.x + 44.0 || abs(q.y) > hs.y + 44.0) continue;
    float kind = a.z;
    // Estiramiento líquido: alarga en la dirección de la velocidad y estrecha en la perpendicular.
    float sp = length(b.xy);
    if (sp > 1.0) {
      vec2 dir = b.xy / sp;
      float st = min(0.2, sp / 5200.0) * (kind > 1.5 ? 1.0 : 0.25);
      float par = dot(q, dir) / (1.0 + st);
      vec2 perp = q - dir * dot(q, dir);
      q = dir * par + perp * (1.0 + st * 0.55);
    }
    float rad = min(a.x, min(hs.x, hs.y));
    float B = max(2.0, a.y);
    float d = gBox(q, hs, rad);
    float alpha = b.w;
    // Sombra de contacto (proyectada hacia abajo).
    float ds = gBox(q - vec2(0.0, kind > 1.5 ? 2.0 : 7.0), hs, rad);
    float shW = kind > 1.5 ? 6.0 : 18.0;
    float shA = kind > 1.5 ? 0.22 : 0.42;
    g.shadow = max(g.shadow, shA * alpha * exp(-max(ds, 0.0) / shW) * smoothstep(-2.0, 2.0, d));
    float cov = clamp(0.5 - d, 0.0, 1.0) * alpha;
    if (cov <= 0.0) continue;
    // Normal continua: SDF con esquinas redondeadas al menos tanto como el bisel.
    float rn = max(rad, min(B * 1.15, min(hs.x, hs.y)));
    vec2 dn = abs(q) - hs + rn;
    vec2 gq = (dn.x > 0.0 || dn.y > 0.0) ? normalize(max(dn, 0.0) + 1e-4) : (dn.x > dn.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vec2 n = gq * vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0);
    float s = max(-d, 0.0);
    float x = clamp(s / B, 0.0, 1.0);
    float u = 1.0 - x;
    float u4 = u * u * u * u;
    float slope = u * u * u * pow(max(1.0 - u4, 1e-3), -0.75);
    float tilt = min(atan(slope * 0.62), 1.32);
    // Desplazamiento: forma de la ley de Snell sobre el perfil, con la pendiente acotada (≤ 0,75)
    // para que la imagen se amplíe y se curve en el canto sin plegarse ni invertirse (sin rayas).
    float strength = (kind < 0.5 ? 1.0 : kind < 1.5 ? 1.1 : 0.95) * a.w * uGK;
    float shift = B * 0.55 * pow(u, 2.5) * strength;
    g.off += n * shift * cov;
    float tr = kind < 0.5 ? 0.46 : kind < 1.5 ? 0.5 : kind < 2.5 ? 0.78 : 0.74;
    g.trans *= mix(1.0, tr, cov);
    // Vidrio claro: el fondo se ve nítido y atenuado, no como una masa desenfocada.
    g.frost = max(g.frost, (kind < 0.5 ? 0.22 : kind < 1.5 ? 0.18 : 0.08) * cov);
    g.cov = max(g.cov, cov);
    g.bevel = (1.0 - smoothstep(0.0, 1.0, x)) * cov;
    g.x = x;
    g.n = n;
    g.tilt = tilt * cov;
    g.disp = (kind > 1.5 ? 0.7 : 1.0) * cov;
    g.kind = kind;
    g.shadow *= 1.0 - cov;
  }
  return g;
}

// Sombra exterior: se aplica al fondo antes de componer el cristal.
vec3 glassShadow(vec3 col, Glass g){
  return col * (1.0 - g.shadow);
}

// Compone el cristal sobre el fondo ya refractado (bg), en el pixel p (px CSS).
vec3 glassShade(vec3 bg, vec3 outside, Glass g, vec2 p){
  if (g.cov <= 0.0) return outside;
  vec3 tint = vec3(0.012, 0.018, 0.034);
  vec3 col = bg * g.trans + tint * (1.0 - g.trans);
  float ct = cos(g.tilt);
  float st = sin(g.tilt);
  vec3 N = normalize(vec3(g.n * st, ct));
  vec3 L = normalize(uGLight);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  // Volumen: el canto que mira a la luz se aclara y el opuesto se oscurece.
  float lam = dot(N, L);
  col *= mix(1.0, 0.72 + 0.5 * clamp(lam, 0.0, 1.0), g.bevel);
  // Reflejo del entorno con Fresnel (Schlick).
  float F = 0.04 + 0.96 * pow(1.0 - ct, 5.0);
  vec3 env = glassEnv(p, g.n, g.x);
  col = mix(col, env, clamp(F * 0.9, 0.0, 0.9));
  // Especular directo y brillo de la cara opuesta.
  float s1 = pow(max(dot(N, H), 0.0), 64.0);
  vec3 Nb = normalize(vec3(-g.n * st, ct));
  float s2 = pow(max(dot(Nb, H), 0.0), 36.0) * 0.38;
  col += uGSpec * (s1 + s2) * g.bevel * 1.15;
  // Cáustica: la luz que atraviesa el bisel se concentra dentro, en el lado opuesto a la luz.
  vec2 l2 = normalize(L.xy + 1e-4);
  float away = clamp(-dot(g.n, l2), 0.0, 1.0);
  float band = smoothstep(0.08, 0.42, g.x) * (1.0 - smoothstep(0.42, 0.95, g.x));
  col += (env * 0.7 + uGSpec * 0.08) * band * away * 0.55 * g.cov;
  // Línea de canto: el borde exterior capta la luz rasante.
  float rim = (1.0 - smoothstep(0.0, 0.06, g.x)) * (0.35 + 0.65 * clamp(dot(g.n, l2), 0.0, 1.0));
  col += uGSpec * rim * 0.22 * g.cov;
  return mix(outside, col, g.cov);
}
`;

/** Luz del cristal: arriba a la izquierda, inclinada levemente hacia el cursor. */
export function glassLight(pointer: { x: number; y: number; on: number }, w: number, h: number): [number, number, number] {
  const px = pointer.on ? (pointer.x / Math.max(1, w) - 0.5) : 0;
  const py = pointer.on ? (pointer.y / Math.max(1, h) - 0.5) : 0;
  return [-0.52 + px * 0.55, -0.72 + py * 0.45, 0.62];
}
