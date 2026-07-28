export function ThinkingDots() {
    const delays = ['0ms', '150ms', '300ms'];

    return (
        <div className="flex gap-1.5 items-center py-0.5">
            {delays.map((delay) => (
                <div
                    key={delay}
                    className="h-1.5 w-1.5 rounded-full animate-bounce"
                    style={{
                        animationDuration: '0.8s',
                        animationDelay: delay,
                        background: 'var(--accent-success)',
                    }}
                />
            ))}
        </div>
    );
}

export default ThinkingDots;
