const fs = require('fs');
let text = fs.readFileSync('src/app/workspace/[slug]/page.jsx', 'utf8');

text = text.replace(/const \[editorVersion, setEditorVersion\] = useState\(0\);/, 'const triggerAnalysisRef = useRef(null);');

text = text.replace(/    \/\/ Subscribe to editor changes to force re-analysis[\s\S]*?    \}, \[editor\]\);/, `    // Subscribe to editor changes to force re-analysis even for remote changes or undo/redo
    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile) return;
        if (!connectionMeta?.isConnected) return;
        if (!editor) return;

        const disposable = editor.onDidChangeModelContent(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        });

        if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        const recheckTimer = setTimeout(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        }, 250);

        return () => {
            disposable.dispose();
            clearTimeout(recheckTimer);
        };
    }, [editor, activeFile, hasLoadedInitialFile, connectionMeta?.isConnected]);`);

text = text.replace(/    useEffect\(\(\) => \{\r?\n        if \(!activeFile \|\| !hasLoadedInitialFile \|\| !slug\) return;/, `    useEffect(() => {
        triggerAnalysisRef.current = () => {
            if (!activeFile || !hasLoadedInitialFile || !slug) return;
            
            // Clear timeouts
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
                proactiveTimeoutRef.current = null;
            }
            if (aiTimeoutRef.current) {
                clearTimeout(aiTimeoutRef.current);
                aiTimeoutRef.current = null;
            }
`);

text = text.replace(/        return \(\) => \{\r?\n            if \(proactiveTimeoutRef\.current\) \{\r?\n                clearTimeout\(proactiveTimeoutRef\.current\);\r?\n                proactiveTimeoutRef\.current = null;\r?\n            \}\r?\n            if \(aiTimeoutRef\.current\) \{\r?\n                clearTimeout\(aiTimeoutRef\.current\);\r?\n                aiTimeoutRef\.current = null;\r?\n            \}\r?\n        \};\r?\n    \}, \[[^\]]*\]\);/, `        }; // end triggerAnalysisRef.current
    }); // run on every render to capture fresh props`);

fs.writeFileSync('src/app/workspace/[slug]/page.jsx', text);
console.log('done!');
