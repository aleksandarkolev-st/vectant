export const fileSuggestionStatusClasses = (status) => {
    switch (status) {
        case 'saving':
            return 'text-amber-200 bg-amber-500/10 border border-amber-500/40';
        case 'applied':
            return 'text-emerald-200 bg-emerald-500/10 border border-emerald-500/40';
        case 'rejected':
            return 'text-gray-300 bg-gray-600/10 border border-gray-500/30';
        case 'error':
            return 'text-rose-200 bg-rose-500/10 border border-rose-500/40';
        default:
            return 'text-amber-200 bg-amber-500/10 border border-amber-500/40';
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
