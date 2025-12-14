import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, checkoutBranch } from '@/redux/gitSlice';

export function BranchSelector({ slug }) {
    const dispatch = useDispatch();
    const { branches, currentBranch, loading } = useSelector(state => state.git);

    useEffect(() => {
        if (slug) {
            dispatch(fetchGitStatus(slug));
        }
    }, [slug, dispatch]);

    const handleValueChange = (e) => {
        const value = e.target.value;
        if (value === 'create-new') {
            const branchName = prompt("Enter new branch name:");
            if (branchName) {
                dispatch(checkoutBranch({ slug, branch: branchName, create: true }));
            }
        } else {
            dispatch(checkoutBranch({ slug, branch: value }));
        }
    };

    // Ensure branches.local is an array
    const localBranches = Array.isArray(branches?.local) ? branches.local : [];

    return (
        <div className="flex items-center gap-2 px-2">
            <span className="text-xs text-gray-500">Branch:</span>
            <select 
                value={currentBranch || ''} 
                onChange={handleValueChange}
                className="bg-transparent text-sm border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
                disabled={loading}
            >
                <optgroup label="Local Branches">
                    {localBranches.map(b => (
                        <option key={b} value={b}>{b}</option>
                    ))}
                </optgroup>
                <option value="create-new">+ Create New Branch</option>
            </select>
        </div>
    );
}
