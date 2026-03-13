import re
import os

target = r"src/app/workspace/[slug]/page.jsx"

with open(target, 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Replace editorVersion state
text = re.sub(
    r"const \[editorVersion, setEditorVersion\] = useState\(0\);",
    r"const triggerAnalysisRef = useRef(null);",
    text
)

# 2. Replace the event listener useEffect
old_listener = r"""    // Subscribe to editor changes to force re-analysis even for remote changes or undo/redo
    useEffect\(\(\) => \{
        if \(!activeFile \|\| !hasLoadedInitialFile\) return;

        // The first file can be selected before the gateway WebSocket is ready;
        // waiting for CONNECTED ensures we don't "miss" the initial analysis.
        if \(!connectionMeta\?\.isConnected\) return;
        if \(!editor\) return;

        const disposable = editor\.onDidChangeModelContent\(\(\) => \{
            setEditorVersion\(v => v \+ 1\);
        \}\);

        // Important: Monaco/Yjs may apply an initial sync update immediately after the editor instance
        // is created, before we can attach onDidChangeModelContent\. Force a short re-check to avoid
        // analyzing an old snapshot and pinning diagnostics to the wrong lines\.
        setEditorVersion\(v => v \+ 1\);
        const recheckTimer = setTimeout\(\(\) => \{
            setEditorVersion\(v => v \+ 1\);
        \}, 250\);

        return \(\) => \{
            disposable\.dispose\(\);
            clearTimeout\(recheckTimer\);
        \};
    \}, \[editor\]\);"""

new_listener = """    // Subscribe to editor changes to force re-analysis even for remote changes or undo/redo
    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile) return;

        if (!connectionMeta?.isConnected) return;
        if (!editor) return;

        const disposable = editor.onDidChangeModelContent(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        });

        // Trigger right away (simulating initial setEditorVersion)
        if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        
        const recheckTimer = setTimeout(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        }, 250);

        return () => {
            disposable.dispose();
            clearTimeout(recheckTimer);
        };
    }, [editor, activeFile, hasLoadedInitialFile, connectionMeta?.isConnected]);"""

text = text.replace(old_listener, new_listener)


# 3. Replace the big UseEffect structure
old_effect_start = """    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile || !slug) return;"""

new_effect_start = """    useEffect(() => {
        triggerAnalysisRef.current = () => {
        if (!activeFile || !hasLoadedInitialFile || !slug) return;
        
        // Clear timeouts exactly as we did before
        if (proactiveTimeoutRef.current) {
            clearTimeout(proactiveTimeoutRef.current);
            proactiveTimeoutRef.current = null;
        }
        if (aiTimeoutRef.current) {
            clearTimeout(aiTimeoutRef.current);
            aiTimeoutRef.current = null;
        }
"""

text = text.replace(old_effect_start, new_effect_start)


# 4. Replace the dependencies of the BIG useEffect
# We need to find the ending bracket `    }, [\n... editorVersion`
old_effect_end = """        return () => {
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
                proactiveTimeoutRef.current = null;
            }
            if (aiTimeoutRef.current) {
                clearTimeout(aiTimeoutRef.current);
                aiTimeoutRef.current = null;
            }
        };
    }, [
        activeFile,
        hasLoadedInitialFile,
        connectionMeta?.isConnected,
        analyzeProactive,
        getRelatedFilesForAnalysis,
        slug,
        analyzeUnified,
        computeContentHash,
        editorVersion,
        getLatestCurrentContent,
        healFromDiagnostics,
    ]);"""

new_effect_end = """        }; // end of triggerAnalysisRef.current function
    }); // Runs on every render without deps so it captures fresh scope!"""

# The exact end of the useEffect in file:
old_effect_end_exact = """        return () => {
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
                proactiveTimeoutRef.current = null;
            }
            if (aiTimeoutRef.current) {
                clearTimeout(aiTimeoutRef.current);
                aiTimeoutRef.current = null;
            }
        };
    }, [
        activeFile,
        hasLoadedInitialFile,
        connectionMeta?.isConnected,
        analyzeProactive,
        getRelatedFilesForAnalysis,
        slug,
        analyzeUnified,
        computeContentHash,
        editorVersion,
        getLatestCurrentContent,
        healFromDiagnostics,
    ]);"""

text = text.replace(old_effect_end_exact, new_effect_end)

with open(target, 'w', encoding='utf-8') as f:
    f.write(text)
    
print("Replaced!")
