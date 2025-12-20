import React, { useState, useRef, useEffect } from 'react';

export function DraggableVideoWidget({
    guiConfig,
    setGuiConfig,
    isGuiRunning,
    setIsGuiRunning,
    mediaStream,
    sendGuiEvent
}) {
    const [position, setPosition] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const videoRef = useRef(null);
    const containerRef = useRef(null);

    // Initialize position on mount
    useEffect(() => {
        if (typeof window !== 'undefined' && guiConfig && position === null) {
             const initialX = window.innerWidth - (guiConfig.width || 640) - 40;
             const initialY = window.innerHeight - (guiConfig.height || 480) - 40;
             setPosition({ x: Math.max(20, initialX), y: Math.max(20, initialY) });
        }
    }, [guiConfig, position]);

    // Dragging logic
    const handleDragStart = (e) => {
        if (e.target.closest('button')) return; // Don't drag if clicking close button
        setIsDragging(true);
        const rect = containerRef.current.getBoundingClientRect();
        dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        e.preventDefault(); // Prevent text selection
    };

    useEffect(() => {
        const handleDragMove = (e) => {
            if (!isDragging) return;
            setPosition({
                x: e.clientX - dragOffset.current.x,
                y: e.clientY - dragOffset.current.y
            });
        };

        const handleDragEnd = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleDragMove);
            window.addEventListener('mouseup', handleDragEnd);
        }

        return () => {
            window.removeEventListener('mousemove', handleDragMove);
            window.removeEventListener('mouseup', handleDragEnd);
        };
    }, [isDragging]);

    // GUI Interaction Logic
    useEffect(() => {
        const el = videoRef.current;
        if (!el || !guiConfig) return;

        // Calculate coordinates relative to the Xvfb display resolution (guiConfig.width/height)
        // This must account for:
        // 1. The video element's position on screen (getBoundingClientRect)
        // 2. object-contain letterboxing (video may be smaller than container)
        // 3. Scaling from displayed size to actual Xvfb resolution
        const toDisplayCoords = (clientX, clientY) => {
            const rect = el.getBoundingClientRect();
            
            // The target resolution is the Xvfb display size
            const targetWidth = guiConfig.width || 640;
            const targetHeight = guiConfig.height || 480;
            
            // Calculate the actual displayed video size with object-contain
            // object-contain maintains aspect ratio and fits within the container
            const containerWidth = rect.width;
            const containerHeight = rect.height;
            
            const videoAspect = targetWidth / targetHeight;
            const containerAspect = containerWidth / containerHeight;
            
            let renderedWidth, renderedHeight, offsetX, offsetY;
            
            if (containerAspect > videoAspect) {
                // Container is wider than video - letterboxed on sides
                renderedHeight = containerHeight;
                renderedWidth = containerHeight * videoAspect;
                offsetX = (containerWidth - renderedWidth) / 2;
                offsetY = 0;
            } else {
                // Container is taller than video - letterboxed on top/bottom
                renderedWidth = containerWidth;
                renderedHeight = containerWidth / videoAspect;
                offsetX = 0;
                offsetY = (containerHeight - renderedHeight) / 2;
            }
            
            // Convert client coordinates to video-relative coordinates
            const relX = clientX - rect.left - offsetX;
            const relY = clientY - rect.top - offsetY;
            
            // Scale to Xvfb resolution
            const x = Math.round((relX / renderedWidth) * targetWidth);
            const y = Math.round((relY / renderedHeight) * targetHeight);
            
            // Clamp to valid range (in case click is in letterbox area)
            return { 
                x: Math.max(0, Math.min(targetWidth - 1, x)), 
                y: Math.max(0, Math.min(targetHeight - 1, y)) 
            };
        };

        const handleMouseMove = (ev) => {
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'move', x, y });
        };
        const handleMouseDown = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'down', x, y, button });
            try { el.focus(); } catch (e) {}
            ev.preventDefault();
        };
        const handleMouseUp = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'up', x, y, button });
            ev.preventDefault();
        };
        const handleWheel = (ev) => {
            sendGuiEvent({ type: 'mouse', action: 'wheel', deltaY: ev.deltaY });
            ev.preventDefault();
        };

        const handleKeyDown = (ev) => {
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'down', key: ev.key });
        };
        const handleKeyUp = (ev) => {
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'up', key: ev.key });
        };

        el.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mouseup', handleMouseUp);
        el.addEventListener('wheel', handleWheel, { passive: false });
        el.addEventListener('keydown', handleKeyDown);
        el.addEventListener('keyup', handleKeyUp);

        return () => {
            el.removeEventListener('mousemove', handleMouseMove);
            el.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mouseup', handleMouseUp);
            el.removeEventListener('wheel', handleWheel);
            el.removeEventListener('keydown', handleKeyDown);
            el.removeEventListener('keyup', handleKeyUp);
        };
    }, [guiConfig, sendGuiEvent]);

    // Force video refresh on HMR update to ensure new frames are rendered
    useEffect(() => {
        const handleHmrUpdate = () => {
            if (videoRef.current && mediaStream) {
                console.log('Refreshing video stream display for HMR...');
                // Force a re-sync of the video element to ensure it picks up the new stream content
                // This helps if the browser's media engine gets stuck on the last frame
                const video = videoRef.current;
                const currentSrc = video.srcObject;
                
                // Quick toggle to force re-render without significant visual interruption
                // We don't set it to null to avoid a black flash if possible, 
                // but sometimes it's necessary. Let's try just play() first.
                video.play().catch(() => {});
                
                // If that's not enough, we might need to re-assign srcObject
                // video.srcObject = currentSrc; 
            }
        };

        window.addEventListener('synthi:hmr-update', handleHmrUpdate);
        return () => window.removeEventListener('synthi:hmr-update', handleHmrUpdate);
    }, [mediaStream]);

    if (!guiConfig) return null;

    // If position is not yet calculated, render hidden or default
    const style = position ? {
        left: position.x,
        top: position.y,
        width: guiConfig.width, 
        height: guiConfig.height,
        maxWidth: '90vw',
        maxHeight: '90vh',
        zIndex: 999
    } : {
        visibility: 'hidden'
    };

    return (
        <div 
            ref={containerRef}
            className="fixed bg-black border border-gray-600 shadow-lg resize overflow-hidden flex flex-col"
            style={style}
        >
            <div 
                onMouseDown={handleDragStart}
                className="bg-gray-800 text-white text-xs px-2 py-1 z-10 flex items-center gap-2 cursor-move w-full shrink-0 select-none"
            >
                <span>GUI Output ({guiConfig.width}x{guiConfig.height})</span>
                {!isGuiRunning && <span className="text-red-400 font-bold">[STOPPED]</span>}
                <button 
                    onClick={(e) => { 
                        e.stopPropagation(); 
                        setGuiConfig(null); 
                        setIsGuiRunning(false); 
                    }} 
                    className="ml-auto text-red-400 hover:text-red-300 px-2"
                >
                    ✕
                </button>
            </div>
            <div className="flex-1 relative overflow-hidden bg-black w-full h-full">
                {mediaStream ? (
                    <video
                        ref={(el) => {
                            videoRef.current = el;
                            if (el && mediaStream && el.srcObject !== mediaStream) {
                                el.srcObject = mediaStream;
                            }
                        }}
                        tabIndex={0}
                        autoPlay
                        playsInline
                        muted
                        className="block w-full h-full object-contain"
                        onClick={() => { try { videoRef.current && videoRef.current.focus(); } catch (e) {} }}
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-500">
                        {isGuiRunning ? 'Waiting for video stream...' : 'Application exited'}
                    </div>
                )}
            </div>
        </div>
    );
}
