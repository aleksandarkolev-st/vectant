import { useEffect } from 'react';

export const useEditorEvents = ({
    editorInstance,
    cancelActiveCompletion,
    requestAiCompletion,
    hasActiveDiff,
    aiAutoEnabled = true
}) => {
    useEffect(() => {
        if (!editorInstance) return;
        const disposables = [];
        try {
            disposables.push(editorInstance.onDidType((text) => {
                cancelActiveCompletion({ resetSuggestion: true, reason: 'typing' });
                const lastChar = (text || '').slice(-1);
                const isPunctuation = /[\(\)\{\}\[\];,]/.test(lastChar);
                const isEnter = lastChar === '\n';
                if (hasActiveDiff()) return;
                if (!aiAutoEnabled) return;
                if (isPunctuation || isEnter) {
                    requestAiCompletion(true, null, { reason: isEnter ? 'enter' : 'punctuation', enterTrigger: isEnter });
                }
            }));
            disposables.push(editorInstance.onDidChangeCursorSelection((e) => {
                // Ignore cursor moves that come from normal typing; only cancel if the
                // user actually moves/extends the selection (mouse or keyboard select).
                const source = e?.source;
                const selection = e?.selection;
                const hasSelection = selection && !selection.isEmpty();
                const isMouse = source === 'mouse';
                if (!isMouse && !hasSelection) return;
                cancelActiveCompletion({ resetSuggestion: true, reason: isMouse ? 'cursor-move' : 'selection-change' });
            }));
        } catch (e) {
            // ignore if monaco is missing APIs
        }

        return () => {
            disposables.forEach((disposable) => disposable?.dispose?.());
        };
    }, [editorInstance, cancelActiveCompletion, requestAiCompletion, hasActiveDiff, aiAutoEnabled]);
};
