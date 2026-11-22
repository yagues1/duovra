import { memo, useId, type CSSProperties } from 'react';
import type { AgentId } from '../../lib/types';
import type { Activity } from '../../lib/activity';
import { poses, restingArms } from './mascotPoses';
import { useMascotMotion } from './useMascotMotion';

export const Mascot = memo(function Mascot({ agent, state, size, animated = true, className, label, phase }: {
  agent: AgentId;
  state: Activity;
  size: number;
  animated?: boolean;
  className?: string;
  label?: string;
  /** Fase real del turno que matiza la pose (p. ej. `starting` mientras se prepara la ejecución). */
  phase?: 'starting';
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const claude = agent === 'claude';
  const small = size < 40;
  const moving = animated && !small;
  const ref = useMascotMotion(moving);
  const pose = poses[state];
  const arms = pose.arm ?? restingArms;
  const treatment = small ? 'minimal' : 'studio';
  const paint = claude
    ? { light: '#f7c29d', base: '#eba37e', edge: '#bb6d51', limb: '#9b5b46', ink: '#392219', eyes: '#38231d' }
    : { light: '#b2e9ed', base: '#83d4e1', edge: '#4ba2b6', limb: '#397c8e', ink: '#15323c', eyes: '#dcf8ff' };
  const status = state === 'waiting' ? '#e5bb80' : state === 'error' ? '#f39ca7' : state === 'done' ? '#a2d5af' : paint.base;

  return (
    <svg ref={ref} className={['mascot', className].filter(Boolean).join(' ')} data-s={state} data-agent={agent} data-treatment={treatment}
      data-static={!moving ? '' : undefined} data-phase={phase} data-size={small ? undefined : size < 56 ? 'medium' : 'large'}
      viewBox={small ? (claude ? '17 11 60 68' : '13 26 66 54') : '0 0 92 88'}
      width={size} height={size} aria-hidden={label ? undefined : true} focusable="false"
      role={label ? 'img' : undefined} aria-label={label}
      style={{
        '--mascot-lean': pose.lean + 'deg',
        '--mascot-pitch': (pose.pitch ?? 0) + 'deg',
        '--mascot-yaw': (pose.yaw ?? 0) + 'deg',
        '--mascot-look-x': (pose.gaze?.[0] ?? 0) + 'px',
        '--mascot-look-y': (pose.gaze?.[1] ?? 0) + 'px',
      } as CSSProperties}>
      {!small && (
        <>
          <defs>
            <linearGradient id={id + '-paint'} x1="0" x2=".72" y1="0" y2="1" gradientUnits="objectBoundingBox">
              <stop stopColor={paint.light} />
              <stop offset=".51" stopColor={paint.base} />
              <stop offset="1" stopColor={paint.edge} />
            </linearGradient>
          </defs>
          <ellipse className="mascot-contact" cx="46" cy="80" rx="22" ry="3" fill="#07090d" opacity=".6" />
        </>
      )}
      <g className="mascot-depth">
        <g className="mascot-body">
          {!small && (
            <path className="mascot-arm" d={arms} style={moving ? { d: `path('${arms}')` } : undefined}
              fill="none" stroke={paint.limb} strokeWidth="4.6" strokeLinecap="round" />
          )}
          {claude ? (
            <g className="mascot-antenna">
              <path d="M45 34q0-12 10-17" fill="none" stroke={paint.base} strokeWidth="3.5" strokeLinecap="round" />
              <circle cx="55" cy="17" r="4.3" fill={status} />
              {!small && <circle cx="54" cy="16" r="1.25" fill={paint.light} />}
            </g>
          ) : (
            <path className="mascot-temples" d="M21 48h-3v13h3m50-13h3v13h-3" fill="none" stroke={paint.limb} strokeWidth="5.8" strokeLinecap="round" />
          )}
          {!small && <path d="M31 73h8v6h-8zm22 0h8v6h-8z" fill={paint.limb} stroke={paint.limb} strokeWidth="2" strokeLinejoin="round" />}
          <path d="M46 30c15 0 25 10 25 24S62 76 46 76 21 68 21 54 31 30 46 30Z"
            fill={small ? paint.base : 'url(#' + id + '-paint)'} stroke={paint.edge} strokeWidth={small ? 0 : 1} />
          {!claude && (
            <>
              <rect className="mascot-visor" x="27.5" y="42" rx="8" width="37" height="19" fill={paint.ink} />
              {!small && <path d="M33 45h26" stroke="#446b77" strokeWidth="1" strokeLinecap="round" />}
            </>
          )}
          <g className="mascot-gaze">
            <path className="mascot-eyes" d={pose.eyes} style={moving ? { d: `path('${pose.eyes}')` } : undefined}
              fill="none" stroke={paint.eyes} strokeWidth="3.15" strokeLinecap="round" />
          </g>
          {!small && claude && <path className="mascot-brows" d="M35 46l5-1m10-2h5" fill="none" stroke={paint.ink} strokeWidth="1.55" strokeLinecap="round" />}
          <path className="mascot-mouth" d={pose.mouth} style={moving ? { d: `path('${pose.mouth}')` } : undefined}
            fill="none" stroke={paint.ink} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
          {!small && pose.hand && <path key={state} className="mascot-hand" d={pose.hand} fill="none" stroke={paint.limb} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />}
        </g>
        {!small && (pose.prop || pose.mark) && (
          <g key={state} className="mascot-prop" stroke={status} strokeLinecap="round" strokeLinejoin="round">
            {pose.prop && <path d={pose.prop} fill="#1b1d24" strokeWidth="2" />}
            {pose.mark && <path className="mascot-mark" d={pose.mark} fill="none" strokeWidth="2.3" />}
          </g>
        )}
      </g>
      {moving && <rect className="mascot-hit" x="15" y="17" width="62" height="61" fill="transparent" />}
    </svg>
  );
});
