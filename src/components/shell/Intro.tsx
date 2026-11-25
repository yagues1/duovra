import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { INTRO_EXIT_MS, INTRO_REDUCED_MS, introHoldMs, shouldPlayIntro } from './introTiming';
import mark from '../../assets/duovra-mark.svg';

let play: boolean | undefined;
function playIntro() {
  return play ??= shouldPlayIntro(window.sessionStorage);
}

export function Intro({ reduced }: { reduced: boolean }) {
  const ready = useStore((s) => s.ready);
  const [show, setShow] = useState(playIntro);
  const [startedAt] = useState(() => performance.now());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!ready || !show) return;
    const skip = () => setShow(false);
    const hold = introHoldMs(performance.now() - startedAt, reduced);
    let end: number | undefined;
    const out = window.setTimeout(() => {
      setLeaving(true);
      end = window.setTimeout(skip, reduced ? INTRO_REDUCED_MS : INTRO_EXIT_MS);
    }, hold);
    window.addEventListener('pointerdown', skip, { capture: true });
    window.addEventListener('keydown', skip, { capture: true });
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(end);
      window.removeEventListener('pointerdown', skip, { capture: true });
      window.removeEventListener('keydown', skip, { capture: true });
    };
  }, [ready, reduced, show, startedAt]);

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
