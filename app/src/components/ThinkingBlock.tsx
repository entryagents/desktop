import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  streaming: boolean;
}

/** Entry web ThinkingBlock equivalent: sparkles icon + live elapsed seconds + collapsed reasoning. */
export default function ThinkingBlock({ text, streaming }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming) {
      if (startRef.current !== null) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      return;
    }
    if (startRef.current === null) startRef.current = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current!) / 1000)), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  return (
    <div className="thinking-block">
      <button type="button" className="thinking-head" onClick={() => setOpen(!open)}>
        <svg className="ico"><use href="#i-sparkles" /></svg>
        <span className="thinking-label">
          {streaming ? `Thinking for ${elapsed}s` : `Thought for ${elapsed || 1}s`}
        </span>
        <svg className="ico chev"><use href={open ? "#i-chev-up" : "#i-chev-down"} /></svg>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}
