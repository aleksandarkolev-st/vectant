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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
            <div className="w-full max-w-lg p-6 rounded-lg bg-[#1b1b1b] border border-gray-700 shadow-lg">
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                        <div className="text-3xl font-bold text-red-400">⚠️</div>
                        <div className="text-xl font-semibold">Workspace not found</div>
                    </div>
                    <div className="text-sm text-gray-300">
                        {slug ? (
                            <>
                                Could not find workspace <strong className="text-white">{slug}</strong> in the database. It may have been removed or the link is invalid.
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
