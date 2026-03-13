import re
import os

target = r"src/app/workspace/[slug]/page.jsx"

with open(target, 'r', encoding='utf-8') as f:
    text = f.read()

# Fix 1
old1 = """        if (isFileSwitch) {
            const currentNorm = normalizePath(currentFilePath);
            setDiagnostics(prev => prev.filter(d => {
                const diagPath = d?.filePath || d?.file || d?.path || '';
                if (!diagPath) return true;
                return normalizePath(diagPath) !== currentNorm;
            }));"""

new1 = """        if (isFileSwitch) {
            const currentNorm = normalizePath(currentFilePath);
            setDiagnostics(prev => {
                const next = prev.filter(d => {
                    const diagPath = d?.filePath || d?.file || d?.path || '';
                    if (!diagPath) return true;
                    return normalizePath(diagPath) !== currentNorm;
                });
                return next.length === prev.length ? prev : next;
            });"""

text = text.replace(old1, new1)

# Fix 2
old2 = """            setDiagnostics(prev => {
                const currentNorm = normalizePath(currentFilePath);
                return prev.filter(d => {
                    const diagPath = d.filePath || d.file || '';
                    if (!diagPath) return false;
                    const isSameFile = normalizePath(diagPath) === currentNorm;
                    if (!isSameFile) return true;
                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                    return isAi;
                });
            });"""

new2 = """            setDiagnostics(prev => {
                const currentNorm = normalizePath(currentFilePath);
                const next = prev.filter(d => {
                    const diagPath = d.filePath || d.file || '';
                    if (!diagPath) return false;
                    const isSameFile = normalizePath(diagPath) === currentNorm;
                    if (!isSameFile) return true;
                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                    return isAi;
                });
                return next.length === prev.length ? prev : next;
            });"""

text = text.replace(old2, new2)

with open(target, 'w', encoding='utf-8') as f:
    f.write(text)

print("Done")