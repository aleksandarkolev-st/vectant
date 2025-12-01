import { useCallback, useMemo, useRef, useState } from 'react';

const createChatSession = (index = 1) => ({
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `Chat ${index}`,
    messages: [],
    suggestedCode: null,
    showDiff: true,
    fileSuggestions: [],
});

export const useChatSessions = () => {
    const sessionCounterRef = useRef(2);
    const initialSessionRef = useRef(createChatSession(1));
    const [chatSessions, setChatSessions] = useState([initialSessionRef.current]);
    const [activeSessionId, setActiveSessionId] = useState(initialSessionRef.current.id);

    const activeSession = useMemo(
        () => chatSessions.find((session) => session.id === activeSessionId) || chatSessions[0] || null,
        [chatSessions, activeSessionId]
    );

    const mutateSession = useCallback((sessionId, mutator) => {
        setChatSessions((prev) =>
            prev.map((session) => {
                if (session.id !== sessionId) return session;
                return mutator(session);
            })
        );
    }, []);

    const appendMessagesToSession = useCallback((sessionId, newMessages) => {
        mutateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages, ...newMessages],
        }));
    }, [mutateSession]);

    const handleNewSession = useCallback(() => {
        const newSession = createChatSession(sessionCounterRef.current);
        sessionCounterRef.current += 1;
        setChatSessions((prev) => [...prev, newSession]);
        setActiveSessionId(newSession.id);
    }, []);

    const handleCloseSession = useCallback((sessionId) => {
        setChatSessions((prev) => {
            if (prev.length <= 1) return prev;
            const filtered = prev.filter((session) => session.id !== sessionId);
            if (activeSessionId === sessionId) {
                const fallback = filtered[filtered.length - 1]?.id ?? filtered[0]?.id ?? null;
                setActiveSessionId(fallback);
            }
            return filtered.length ? filtered : [createChatSession(1)];
        });
    }, [activeSessionId]);

    const resetSuggestionsForSession = useCallback((sessionId) => {
        mutateSession(sessionId, (session) => ({
            ...session,
            suggestedCode: null,
            fileSuggestions: [],
            showDiff: false,
        }));
    }, [mutateSession]);

    return {
        chatSessions,
        activeSession,
        activeSessionId,
        setActiveSessionId,
        mutateSession,
        appendMessagesToSession,
        handleNewSession,
        handleCloseSession,
        resetSuggestionsForSession,
    };
};
