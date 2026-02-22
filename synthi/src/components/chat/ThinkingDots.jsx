export function ThinkingDots() {
    return (
        <div className="flex gap-1.5 items-center py-0.5">
            <div className="w-1.5 h-1.5 bg-[#4aba9a] rounded-full animate-bounce" style={{ animationDuration: '0.8s' }}></div>
            <div className="w-1.5 h-1.5 bg-[#4aba9a] rounded-full animate-bounce" style={{ animationDuration: '0.8s', animationDelay: '150ms' }}></div>
            <div className="w-1.5 h-1.5 bg-[#4aba9a] rounded-full animate-bounce" style={{ animationDuration: '0.8s', animationDelay: '300ms' }}></div>
        </div>
    );
}

export default ThinkingDots;
