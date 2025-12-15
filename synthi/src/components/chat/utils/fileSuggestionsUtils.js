export const fileSuggestionStatusClasses = (status) => {
    switch (status) {
        case 'saving':
            return 'text-amber-300 bg-amber-500/20 border border-amber-400/50';
        case 'applied':
            return 'text-emerald-300 bg-emerald-500/20 border border-emerald-400/50';
        case 'rejected':
            return 'text-zinc-400 bg-zinc-600/20 border border-zinc-500/40';
        case 'error':
            return 'text-rose-300 bg-rose-500/20 border border-rose-400/50';
        default:
            // Pending - stronger yellow/amber for visibility
            return 'text-amber-300 bg-amber-500/20 border border-amber-400/50';
    }
};

export const fileSuggestionStatusLabel = (status) => {
    switch (status) {
        case 'saving':
            return 'Saving...';
        case 'applied':
            return 'Applied';
        case 'rejected':
            return 'Dismissed';
        case 'error':
            return 'Error';
        default:
            return 'Pending';
    }
};
