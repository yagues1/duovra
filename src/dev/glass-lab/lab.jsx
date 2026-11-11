import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ChevronDown, PanelRight } from 'lucide-react';
import LiquidGlass from '../../../output/qa/liquid-glass/sources/liquid-glass-react/liquid-glass-react-ac48eab18d1f7f444ae30002d240cae29c863a21/src/index';
import { Vaso } from '../../../output/qa/liquid-glass/sources/vaso/vaso-a7ab5b7a2872e8140bdad6deef5b8c4089575dfd/src/index';
import { MorphSurface } from '../../../output/qa/liquid-glass/sources/fluidkit/fluidkit-b1e6e6109e14c31ed43a99e2a373f4727c867ecb/src/components/MorphSurface';
import { MorphingPopover, MorphingPopoverTrigger, MorphingPopoverContent } from '../../../output/qa/liquid-glass/sources/morphing-popover';
import { Background } from '../../components/shell/Background';
import { AgentGlyph } from '../../components/ui/AgentGlyph';
import '../../styles/globals.css';
import './lab.css';

const sizes = { Compositor: [660, 106, 24], Cápsula: [116, 32, 16], Selector: [162, 34, 17],
  Menú: [330, 162, 18], Botón: [38, 38, 19], Panel: [330, 238, 22] };
const params = new URLSearchParams(location.search);
const candidates = ['Base', 'Liquid Glass React', 'Vaso', 'Fluidkit', 'Motion Primitives'];
const sample = params.get('surface') ?? 'Compositor';
const [width, height, radius] = sizes[sample] ?? sizes.Compositor;

function Content({ onToggle, alternate }) {
  if (sample === 'Botón') return <button className="lab-icon" aria-label="Enviar" onClick={onToggle}><ArrowUp size={17} /></button>;
  if (sample === 'Cápsula') return <button className="lab-chip" onClick={onToggle}><AgentGlyph agent={alternate ? 'codex' : 'claude'} size={17} />{alternate ? 'Codex' : 'Claude Code'}</button>;
  if (sample === 'Selector') return <button className="lab-chip" onClick={onToggle}>GPT-6-Luna <small>Alto</small><ChevronDown size={13} /></button>;
  if (sample === 'Menú') return <div className="lab-content"><small>Modelos de Codex</small><p>GPT-6-Luna</p><p>Nivel de razonamiento · Alto</p></div>;
  if (sample === 'Panel') return <div className="lab-content"><PanelRight size={16} /><p>Archivos de la conversación</p><small>math.js · 4 líneas añadidas</small></div>;
  return <div className="lab-content"><div className="lab-placeholder">Escribe a Codex</div><button className="lab-chip" onClick={onToggle}><AgentGlyph agent="codex" size={17} /> Codex</button><button className="lab-chip" onClick={onToggle}>GPT-6-Luna <small>Alto</small><ChevronDown size={13} /></button></div>;
}

function Specimen({ candidate }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((value) => !value);
  const frame = { width, height, borderRadius: radius };
  const content = <Content onToggle={toggle} alternate={open} />;
  if (candidate === 'Liquid Glass React') return <div className="lab-rdev" style={frame}><LiquidGlass mode="prominent" cornerRadius={radius} padding="0"
    displacementScale={52} blurAmount={0.04} saturation={130} aberrationIntensity={0} elasticity={0}
    style={{ ...frame, position: 'absolute', top: '50%', left: '50%' }}>
    <div className="lab-tint" style={frame}>{content}</div>
  </LiquidGlass></div>;
  if (candidate === 'Vaso') return <Vaso {...{ width, height, radius }} depth={2.2} blur={1.6} specular={0.48}
    dispersion={false} style={frame}><div className="lab-tint" style={frame}>{content}</div></Vaso>;
  if (candidate === 'Fluidkit') {
    const openWidth = Math.max(width, 330);
    const openHeight = Math.max(height, 162);
    return <div className="lab-fluid" style={{ width, height }}>
      <MorphSurface open={open} closedSize={{ width, height }} openSize={{ width: openWidth, height: openHeight }}
        style={{ position: 'absolute', left: -(openWidth - width) / 2 - 56, top: -20 }} anchor="top"
        radius={18} tint="#1c3466" opacity={0.68} satellites={sample === 'Cápsula'} intensity="whisper" closedContent={content}
        openContent={<button className="lab-chip" onClick={toggle}>GPT-6-Luna · Alto · Cerrar</button>} />
    </div>;
  }
  if (candidate === 'Motion Primitives') return <MorphingPopover open={open} onOpenChange={setOpen} className="!block" style={frame}>
    <MorphingPopoverTrigger className="mat-primary lab-chip" style={frame}>
      <span className="flex items-center gap-1.5">{sample === 'Botón' ? <ArrowUp size={17} /> : sample === 'Cápsula' ? <><AgentGlyph agent="claude" size={17} /> Claude Code</> : <>GPT-6-Luna <ChevronDown size={13} /></>}</span>
    </MorphingPopoverTrigger>
    <MorphingPopoverContent className="mat-float lab-morph" style={{ borderRadius: 18, width: 330, minHeight: 162 }}>
      <div className="lab-content"><p>GPT-6-Luna · Alto</p><button className="btn" onClick={toggle}>Cerrar</button></div>
    </MorphingPopoverContent>
  </MorphingPopover>;
  return <div className="mat-primary lab-base" data-refract style={frame}><span className="mat-refract" aria-hidden />{content}</div>;
}

function Lab() {
  const visible = params.has('candidate') ? candidates.filter((name) => name === params.get('candidate')) : candidates;
  return <>
    <Background /><LiquidFilters />
    <main className="glass-lab">
      <h1>Laboratorio Liquid Glass</h1>
      <nav aria-label="Superficie">{Object.keys(sizes).map((name) => <a key={name} href={`?surface=${encodeURIComponent(name)}`} aria-current={name === sample ? 'page' : undefined}>{name}</a>)}</nav>
      {visible.map((candidate) => <section className="lab-row" key={candidate} data-candidate={candidate}>
        <h2>{candidate}</h2>
        <div className="lab-scene" data-light={params.get('light') ?? 'mixed'}>
          <div className="lab-target" aria-hidden><span>Refracción · 0123456789 · Cambios en math.js</span></div>
          <div className="lab-specimen"><Specimen candidate={candidate} /></div>
        </div>
      </section>)}
    </main>
  </>;
}

document.documentElement.dataset.intensity = 'full';
document.documentElement.dataset.animations = 'off';
createRoot(document.getElementById('root')).render(<Lab />);

/**
 * Filtro de refracción para el canto de las superficies principales (intensidad completa).
 * Ruido fractal de baja frecuencia + mapa de desplazamiento: dobla lo que hay detrás como un
 * vidrio grueso e irregular. Se aplica solo a una banda estrecha (ver .mat-refract).
 */
function LiquidFilters() {
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <filter id="lg-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="2" seed="11" result="noise" />
        <feGaussianBlur in="noise" stdDeviation="1.5" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale="22" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
