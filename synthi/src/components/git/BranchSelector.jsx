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
            <SelectTrigger className="h-5 w-auto gap-1.5 border-none bg-transparent px-1.5 text-[11px] text-[#f0f2f5] hover:text-[#f0f2f5] hover:bg-[#1c1d26] rounded-full focus:ring-0 focus:ring-offset-0 data-[size=default]:h-5 data-[size=default]:px-1.5 data-[size=default]:py-0 [&>svg:last-child]:w-3 [&>svg:last-child]:h-3 [&>svg:last-child]:opacity-50">
                <GitBranch className="w-3.5 h-3.5 text-[#327464]" strokeWidth={1.5} />
                <SelectValue placeholder="Select branch" />
            </SelectTrigger>
            <SelectContent className="bg-[#0d0e14] border-[#1c1d26] text-[#f0f2f5] min-w-[140px] rounded-lg">
                <SelectGroup>
                    <SelectLabel className="text-[#6b7089] text-xs">Local Branches</SelectLabel>
                    {localBranches.map(b => (
                        <SelectItem 
                            key={b} 
                            value={b}
                            className="text-xs cursor-pointer focus:bg-[#32746420] focus:text-[#f0f2f5] rounded"
                        >
                            {b}
                        </SelectItem>
                    ))}
                </SelectGroup>
                <SelectItem 
                    value="create-new" 
                    className="text-xs cursor-pointer text-[#327464] focus:bg-[#32746420] focus:text-[#327464] rounded"
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
