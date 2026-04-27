'use client';

import React from 'react';
import { useShadowVerify } from './hooks/useShadowVerify';

/**
 * Synthi Genome — StalenessBadge
 *
 * Soft staleness UI shown while a shadow job runs. Master plan §8.5.
 * Turns amber when `staleness_detected` arrives or when the user has
 * touched a file currently being verified.
 */
export function StalenessBadge({ jobId, editedFiles = [] }) {
    const verify = useShadowVerify(jobId);
    if (!jobId || verify.finished) return null;

    const verifying = verify.snapshotFiles || [];
    const stale = (verify.staleFiles || []).length > 0
        || verifying.some((f) => editedFiles.includes(f));

    const label = verifying.length === 0
        ? 'preparing verify…'
        : verifying.length === 1
            ? `verifying ${verifying[0]}`
            : `verifying ${verifying[0]} +${verifying.length - 1}`;

    return (
        <div className={`genome-staleness genome-staleness--${stale ? 'amber' : 'idle'}`}>
            <span aria-hidden="true">🛡</span>
            <span>{label}</span>
            <span className="genome-staleness__hint">
                {stale ? 're-verifying after your edit…' : 'keep editing if you like'}
            </span>
        </div>
    );
}

export default StalenessBadge;
