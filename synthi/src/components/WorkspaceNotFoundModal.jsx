"use client";
import React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export default function WorkspaceNotFoundModal({ slug, message = 'Workspace not found.', open = true }) {
    const router = useRouter();

    const goHome = () => {
        // Redirect to root route
        router.push('/');
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,black_68%,transparent)] backdrop-blur-sm">
            <div className="vt-dialog-surface w-full max-w-lg p-6">
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                        <div className="text-3xl font-bold text-[var(--accent-danger)]">!</div>
                        <div className="text-xl font-semibold text-[var(--text-primary)]">Workspace not found</div>
                    </div>
                    <div className="text-sm text-[var(--text-secondary)]">
                        {slug ? (
                            <>
                                Could not find workspace <strong className="text-[var(--text-primary)]">{slug}</strong> in the database. It may have been removed or the link is invalid.
                            </>
                        ) : (
                            <>No workspace specified.</>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => router.back()}>
                            Go Back
                        </Button>
                        <Button variant="default" size="sm" onClick={goHome}>
                            Go to Home
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
