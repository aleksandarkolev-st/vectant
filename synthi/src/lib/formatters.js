// Client-side helper to register Monaco formatting providers that call the
// server-side `/api/format` route. The providers replace the full document
// with the formatted result returned by the server.

export function registerFormatters(monaco) {
  if (!monaco || !monaco.languages) return;

  const register = (langIds) => {
    langIds.forEach((id) => {
      try {
        monaco.languages.registerDocumentFormattingEditProvider(id, {
          async provideDocumentFormattingEdits(model, options, token) {
            const code = model.getValue();
            try {
              const res = await fetch('/api/format', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ language: id, code })
              });
              if (!res.ok) throw new Error('Formatting failed');
              const json = await res.json();
              if (json?.formatted && typeof json.formatted === 'string') {
                const fullRange = model.getFullModelRange ? model.getFullModelRange() : new monaco.Range(1,1,model.getLineCount(), model.getLineMaxColumn(model.getLineCount()));
                return [{ range: fullRange, text: json.formatted }];
              }
            } catch (err) {
              console.error('Format provider error for', id, err);
            }
            return [];
          }
        });
      } catch (e) {
        // ignore registration problems
      }
    });
  };

  // Register for rust and c/cpp languages, plus common JS/TS to reuse server route
  register(['rust', 'cpp', 'c', 'c++', 'javascript', 'typescript']);
}
