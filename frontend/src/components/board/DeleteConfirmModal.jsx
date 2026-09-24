import { useEffect, useRef, useState } from 'react';

/** Two-step delete confirmation, added 2026-09-24 at the user's request: "add two allerts while
 * deleting one normal another with sound". Step 1 is a plain confirm (amber accent); step 2 adds
 * a synthesized warning beep (Web Audio — no audio file to ship or fetch) plus a red/shake
 * treatment, so the final step reads as unmistakably more serious than the first. Mirrors the
 * preview mockup (delete-mockup.html) shared and approved via AskUserQuestion before this was
 * built for real — same two-tone 880Hz/660Hz square-wave beep, same step progression.
 *
 * Deletes are soft now (archived to the deletedJobs collection, restorable from the hidden
 * Deleted Jobs panel — see server/db.js's deleteJob and Header.jsx's secret trigger), so the copy
 * below deliberately says "archived"/"recoverable", not "permanent" — this modal is about
 * catching an accidental click, not warning about data loss that doesn't actually happen anymore.
 *
 * Pure two-step UI only — DayBoard.jsx's handleDeleteJob still owns calling onDeleteJob and its
 * own try/catch + error alert once the user confirms both steps. */
export default function DeleteConfirmModal({ customerName, onCancel, onConfirm }) {
  const [step, setStep] = useState(1);
  const playedRef = useRef(false);

  // Plays once, the moment step 2 first renders — not on every re-render, and not retried if it
  // silently fails (e.g. autoplay policy without a prior user gesture; unlikely here since this
  // only ever opens from a click, but harmless to guard anyway). The visual red/shake treatment
  // carries the "this is the serious one" signal on its own if the beep doesn't play.
  useEffect(() => {
    if (step !== 2 || playedRef.current) return;
    playedRef.current = true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.001, now + i * 0.16);
        gain.gain.linearRampToValueAtTime(0.15, now + i * 0.16 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.16 + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.16);
        osc.stop(now + i * 0.16 + 0.15);
      });
    } catch (e) {
      // Web Audio unavailable/blocked — fail silently, the step-2 visuals still make the point.
    }
  }, [step]);

  return (
    <div className="job-edit-overlay" onClick={onCancel}>
      <div
        className={`job-edit-modal delete-confirm-modal ${step === 2 ? 'delete-confirm-step2' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {step === 1 ? (
          <>
            <h3>Delete this job?</h3>
            <p className="delete-confirm-body">
              "{customerName}" will move to the Deleted Jobs archive and come off the board. It can be restored later.
            </p>
            <div className="job-edit-actions">
              <span className="job-edit-actions-spacer" />
              <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <h3>⚠ Are you absolutely sure?</h3>
            <p className="delete-confirm-body">
              This removes "{customerName}" from the board right now. It's recoverable from the archive, but this isn't a click to make by accident.
            </p>
            <div className="job-edit-actions">
              <span className="job-edit-actions-spacer" />
              <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
              <button type="button" className="btn danger" onClick={onConfirm}>Delete job</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
