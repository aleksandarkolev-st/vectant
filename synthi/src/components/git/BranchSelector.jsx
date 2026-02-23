import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, checkoutBranch } from '@/redux/gitSlice';
import { GitBranch, Plus, ChevronDown } from 'lucide-react';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

export function BranchSelector({ slug }) {
    const dispatch = useDispatch();
    const { branches, currentBranch, loading } = useSelector(state => state.git);

    useEffect(() => {
        if (slug) {
            dispatch(fetchGitStatus(slug));
        }
    }, [slug, dispatch]);

    const handleValueChange = (value) => {
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
        <Select value={currentBranch || ''} onValueChange={handleValueChange} disabled={loading}>
            <SelectTrigger className="h-5 w-auto gap-1.5 border-none bg-transparent px-1.5 text-[11px] rounded-full focus:ring-0 focus:ring-offset-0 data-[size=default]:h-5 data-[size=default]:px-1.5 data-[size=default]:py-0 [&>svg:last-child]:w-3 [&>svg:last-child]:h-3 [&>svg:last-child]:opacity-50 duration-300 hover:-translate-y-0.5 transition-all cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={1.5} />
                <SelectValue placeholder="Select branch" />
            </SelectTrigger>
            <SelectContent className="min-w-[140px] rounded-lg" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}>
                <SelectGroup>
                    <SelectLabel className="text-xs" style={{ color: 'var(--text-muted)' }}>{localBranches.length > 0 ? 'Local Branches' : 'No branches'}</SelectLabel>
                    {localBranches.map(b => (
                        <SelectItem 
                            key={b} 
                            value={b}
                            className="text-xs cursor-pointer rounded"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {b}
                        </SelectItem>
                    ))}
                </SelectGroup>
                <SelectItem 
                    value="create-new" 
                    className="text-xs cursor-pointer rounded"
                    style={{ color: 'var(--accent-primary)' }}
                >
                    <span className="flex items-center gap-1.5">
                        <Plus className="w-3 h-3" />
                        Create Branch
                    </span>
                </SelectItem>
            </SelectContent>
        </Select>
    );
}
