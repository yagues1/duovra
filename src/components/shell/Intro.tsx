import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { INTRO_MS, INTRO_REDUCED_MS, shouldPlayIntro } from './introTiming';
import mark from '../../assets/duovra-mark.svg';

let play: boolean | undefined;
function playIntro() {
  return play ??= shouldPlayIntro(window.sessionStorage);
}

export function Intro({ reduced }: { reduced: boolean }) {
  const ready = useStore((s) => s.ready);
  const [show, setShow] = useState(playIntro);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!ready || !show) return;
    const skip = () => setShow(false);
    const out = window.setTimeout(() => setLeaving(true), reduced ? 0 : INTRO_MS - 170);
    const end = window.setTimeout(skip, reduced ? INTRO_REDUCED_MS : INTRO_MS);
    window.addEventListener('pointerdown', skip, { capture: true });
    window.addEventListener('keydown', skip, { capture: true });
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(end);
      window.removeEventListener('pointerdown', skip, { capture: true });
      window.removeEventListener('keydown', skip, { capture: true });
    };
  }, [ready, reduced, show]);

  if (!show) return null;
  return (
    <div className="studio-intro" data-leaving={leaving || undefined} data-reduced={reduced || undefined} aria-hidden>
      <div className="studio-intro-lockup">
        <img src={mark} alt="" width={46} height={46} draggable={false} />
        <span>Duovra</span>
      </div>
    </div>
  );
}
