'use client';

import React from 'react';
import { useContinuousFindings } from './hooks/useContinuousFindings';

/**
 * Synthi Genome — regression findings card (Wave 4, master plan §14).
 *
 * Surfaces continuous-shadow's pass→fail transitions in the chat. Each
 * finding includes a "Look at this" action the parent wires to a chat
 * prompt; dismissing hides the finding for the rest of the session.
 *
 * No-ops when:
 *  - no workspace,
 *  - the workspace has opted out,
 *  - there are no current findings.
 */

export function RegressionFindingsCard({ workspacePath, onLookAt }) {
    const { findings, dismiss, optOut, optedOut } = useContinuousFindings(workspacePath);

    if (!workspacePath || optedOut || findings.length === 0) {
        return null;
    }

    return (
        <div className="genome-regression-card">
            <header className="genome-regression-card__head">
                <span aria-hidden="true">🛡</span>
                <span>
                    Continuous shadow detected {findings.length}{' '}
                    {findings.length === 1 ? 'regression' : 'regressions'}
                </span>
                <button
                    type="button"
                    className="genome-regression-card__opt-out"
                    onClick={() => optOut(true)}
                    title="Stop continuous shadow on this workspace"
                >
                    Mute workspace
                </button>
            </header>
            <ul className="genome-regression-card__list">
                {findings.slice(0, 5).map((f) => {
                    const key = `${f.file}:${f.test || ''}`;
                    return (
                        <li key={key} className="genome-regression-card__row">
                            <div className="genome-regression-card__msg">
                                <code>{f.file}</code>
                                <span className="genome-regression-card__note">
                                    {f.note || 'previously-passing test now failing'}
                                </span>
                                {f.test ? (
                                    <span className="genome-regression-card__tests">
                                        {f.test}
                                    </span>
                                ) : null}
                            </div>
                            <div className="genome-regression-card__actions">
                                {onLookAt ? (
                                    <button
                                        type="button"
                                        onClick={() => onLookAt(f)}
                                    >
                                        Look at this
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    className="genome-regression-card__dismiss"
                                    onClick={() => dismiss(f)}
                                >
                                    Dismiss
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default RegressionFindingsCard;
