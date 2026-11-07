import { useState } from "react";
import { bridge } from "../lib/bridge";

interface Props {
  onClose: () => void;
  onPaired: () => void;
}

export default function AuthDialog({ onClose, onPaired }: Props) {
  const [phase, setPhase] = useState<"idle" | "pairing" | "done">("idle");
  const [userCode, setUserCode] = useState("");
  const [error, setError] = useState("");

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
        setPhase("done");
        onPaired();
        return;
      }
      if (res?.user_code) setUserCode(res.user_code);
      if (res?.verification_uri) bridge.openExternal(res.verification_uri);
      // pair.complete event flips auth; poll status shortly after
      setTimeout(async () => {
        const status = (await bridge.call("auth.status")) as { paired?: boolean };
        if (status?.paired) {
          setPhase("done");
          onPaired();
        } else {
          setError("Not approved yet — approve in the browser, then close this dialog.");
        }
      }, 30_000);
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  };

  return (
    <div className="modal-overlay">
      <div className="auth-dialog" role="dialog" aria-modal="true">
        <header className="auth-dialog-header">
          <div className="auth-dialog-brand">
            <svg className="ico"><use href="#i-logo" /></svg>
            <span className="auth-dialog-title">Sign in to Entry Agents</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <svg className="ico"><use href="#i-x" /></svg>
          </button>
        </header>
        <div className="auth-dialog-body">
          <p className="auth-copy">
            Pair this desktop with your Entry account. Your browser opens the approval page;
            the app receives a session token through the device-code flow.
          </p>
          {userCode && (
            <div className="auth-code">
              <span className="auth-code-label">Your code</span>
              <span className="auth-code-value">{userCode}</span>
            </div>
          )}
          {error && <p className="auth-error">{error}</p>}
          <div className="auth-actions">
            <button type="button" className="btn-primary" disabled={phase === "pairing"} onClick={start}>
              {phase === "pairing" ? "Waiting for approval…" : "Open approval page"}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>Later</button>
          </div>
        </div>
      </div>
    </div>
  );
}
