export function ThinkingDots() {
    return (
        <div className="flex gap-1 items-center text-gray-400 animate-pulse">
            <div className="w-2 h-2 bg-gray-500 rounded-full"></div>
            <div className="w-2 h-2 bg-gray-500 rounded-full" style={{ animationDelay: '150ms' }}></div>
            <div className="w-2 h-2 bg-gray-500 rounded-full" style={{ animationDelay: '300ms' }}></div>
        </div>
    );
}

export default ThinkingDots;
