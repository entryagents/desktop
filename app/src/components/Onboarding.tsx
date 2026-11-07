import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";

interface Props {
  onPaired: () => void;
}

/**
 * First-run onboarding (OpenCode-style): pair with the Entry account before
 * anything else. Device-code flow — code shown in-app, approval in browser.
 */
export default function Onboarding({ onPaired }: Props) {
  const [phase, setPhase] = useState<"intro" | "pairing">("intro");
  const [userCode, setUserCode] = useState("");
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [statusLine, setStatusLine] = useState("Waiting for approval…");

  const start = async () => {
    setPhase("pairing");
    setError("");
    try {
      const res = (await bridge.call("pair.start")) as {
        alreadyPaired?: boolean;
        user_code?: string;
        verification_uri?: string;
      };
      if (res?.alreadyPaired) {
        onPaired();
        return;
      }
      setUserCode(res?.user_code ?? "");
      setUri(res?.verification_uri ?? "");
      setStatusLine("Waiting for approval…");
      // Auto-open the browser; if the opener fails we fall back to the
      // visible URL + copy-code below (never a dead end).
      if (res?.verification_uri) {
        try {
          await bridge.openExternal(res.verification_uri);
        } catch {
          /* fallback UI shows the URL */
        }
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("intro");
    }
  };

  // Approve-in-browser shortcut while pairing
  useEffect(() => {
    if (phase !== "pairing" || !uri) return;
    const t = setTimeout(() => bridge.openExternal(uri), 600);
    return () => clearTimeout(t);
  }, [phase, uri]);

  // Poll pairing status; pair.complete event also flips auth in App.
  useEffect(() => {
    if (phase !== "pairing") return;
    const t = setInterval(async () => {
      try {
        const s = (await bridge.call("auth.status")) as { paired?: boolean };
        if (s?.paired) onPaired();
      } catch {
        /* still waiting */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [phase, onPaired]);

  return (
    <div className="onboarding">
      <div className="onb-card">
        <span className="onb-logo"><svg className="ico"><use href="#i-logo" /></svg></span>
        <h1 className="onb-title">Entry Agents</h1>
        <p className="onb-sub">
          Your coding agent, running locally on this machine — paired with your Entry account.
        </p>

        {phase === "intro" && (
          <>
            <ul className="onb-points">
              <li><svg className="ico"><use href="#i-shield" /></svg> Tools run on your system — nothing in a cloud sandbox</li>
              <li><svg className="ico"><use href="#i-credit-card" /></svg> Usage billed to your Entry credits</li>
              <li><svg className="ico"><use href="#i-cpu" /></svg> Model routing through the Entry gateway</li>
            </ul>
            <button type="button" className="onb-primary" onClick={start}>
              Sign in with Entry
            </button>
            <span className="onb-hint">A browser window opens to approve this device.</span>
          </>
        )}

        {phase === "pairing" && (
          <>
            {userCode && (
              <div className="onb-code">
                <span>Enter this code</span>
                <b>{userCode}</b>
                <button
                  type="button"
                  className="onb-copy"
                  onClick={() => void navigator.clipboard?.writeText(userCode).catch(() => {})}
                >
                  Copy code
                </button>
              </div>
            )}
            <div className="onb-wait"><span className="status-bar">{statusLine}</span></div>
            <button type="button" className="onb-secondary" onClick={() => uri && bridge.openExternal(uri)}>
              Open approval page again
            </button>
            {uri && (
              <a className="onb-url" href={uri} onClick={(e) => { e.preventDefault(); bridge.openExternal(uri); }}>
                {uri}
              </a>
            )}
          </>
        )}

        {error && <p className="onb-error">{error}</p>}
      </div>
    </div>
  );
}
