'use client';

import React from 'react';
import { useShadowVerify } from './hooks/useShadowVerify';

/**
 * Synthi Genome — ArbiterCard
 *
 * Renders the cross-universe verdict for Wave 2+ runs:
 *   - Single winner with confidence.
 *   - Confidence < 0.6 ⇒ "Arbiter is uncertain — review all".
 *   - Convergence ⇒ "Consensus" card replacing the arbiter view.
 *   - Synthesis-only crossover hint when arbiter recommends combining.
 *
 * Master plan §6.4 + §11 + §12.
 */

const LOW_CONFIDENCE = 0.6;

function formatConfidence(c) {
    if (typeof c !== 'number') return '—';
    return `${Math.round(c * 100)}%`;
}

function ConsensusBlock({ winner, cohort }) {
    return (
        <div className="genome-arbiter genome-arbiter--consensus">
            <header className="genome-arbiter__head">
                <span aria-hidden="true">⇶</span>
                <span>Consensus reached</span>
            </header>
            <div className="genome-arbiter__body">
                <p>
                    All universes ({cohort.join(', ')}) produced effectively the same
                    patch. Showing universe <strong>{winner}</strong> as the consensus
                    pick — no Arbiter judgment needed.
                </p>
            </div>
        </div>
    );
}

function VerdictBlock({ verdict, onApply }) {
    const uncertain = (verdict.confidence ?? 0) < LOW_CONFIDENCE;
    return (
        <div className={`genome-arbiter ${uncertain ? 'genome-arbiter--uncertain' : 'genome-arbiter--decided'}`}>
            <header className="genome-arbiter__head">
                <span aria-hidden="true">⚖</span>
                {uncertain ? (
                    <span>Arbiter is uncertain — review all universes</span>
                ) : (
                    <span>
                        Arbiter picks <strong>Universe {verdict.winner}</strong>{' '}
                        <span className="genome-arbiter__confidence">
                            ({formatConfidence(verdict.confidence)} confidence)
                        </span>
                    </span>
                )}
                {verdict.source ? (
                    <span className={`genome-arbiter__source genome-arbiter__source--${verdict.source}`}>
                        {verdict.source === 'llm' ? 'LLM' : 'fallback'}
                    </span>
                ) : null}
            </header>
            {verdict.rationale ? (
                <p className="genome-arbiter__rationale">{verdict.rationale}</p>
            ) : null}
            {Array.isArray(verdict.warnings) && verdict.warnings.length > 0 ? (
                <ul className="genome-arbiter__warnings">
                    {verdict.warnings.map((w, i) => (
                        <li key={i}>⚠ {w}</li>
                    ))}
                </ul>
            ) : null}
            {Array.isArray(verdict.tradeoffs) && verdict.tradeoffs.length > 0 ? (
                <div className="genome-arbiter__tradeoffs">
                    {verdict.tradeoffs.map((t, i) => (
                        <span key={i} className="genome-arbiter__tradeoff">
                            {t.axis}: {t.winner}
                        </span>
                    ))}
                </div>
            ) : null}
            {verdict.synthesis?.recommended && verdict.synthesis?.instruction ? (
                <div className="genome-arbiter__synthesis">
                    <strong>Synthesis suggested:</strong>{' '}
                    {verdict.synthesis.explanation || verdict.synthesis.instruction}
                </div>
            ) : null}
            {!uncertain && verdict.winner ? (
                <div className="genome-arbiter__actions">
                    <button type="button" onClick={() => onApply(verdict.winner)}>
                        Apply Universe {verdict.winner}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function ArbiterCard({ jobId }) {
    const verify = useShadowVerify(jobId);
    if (!jobId) return null;

    if (verify.convergence) {
        const cohort = verify.convergence.cohort || Object.keys(verify.universes || {});
        return (
            <ConsensusBlock
                winner={verify.winner || cohort[0]}
                cohort={cohort}
            />
        );
    }
    if (!verify.arbiter) return null;
    return <VerdictBlock verdict={verify.arbiter} onApply={(id) => verify.apply(id)} />;
}

export default ArbiterCard;
