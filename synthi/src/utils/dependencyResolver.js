import { getFileLanguage } from './fileUtils';

const getImports = (content, language) => {
    const imports = [];
    if (!content) return imports;
    const lines = content.split('\n');
    
    if (language === 'cpp' || language === 'c') {
        const includeRegex = /^\s*#include\s+"([^"]+)"/;
        for (const line of lines) {
            const match = line.match(includeRegex);
            if (match) {
                imports.push(match[1]);
            }
        }
    } else if (language === 'rust') {
        const modRegex = /^\s*mod\s+([a-zA-Z0-9_]+)\s*;/;
        for (const line of lines) {
            const match = line.match(modRegex);
            if (match) {
                imports.push(`${match[1]}.rs`);
            }
        }
    } else if (language === 'java') {
        // Java: `import com.example.app.Calculator;` → `com/example/app/Calculator.java`
        // We skip wildcard imports (e.g. `import java.util.*;`) and standard library packages.
        const importRegex = /^\s*import\s+(?:static\s+)?([a-zA-Z_][\w.]*\.[A-Z]\w*)\s*;/;
        const stdPrefixes = ['java.', 'javax.', 'sun.', 'com.sun.', 'org.w3c.', 'org.xml.', 'org.ietf.', 'jdk.'];
        for (const line of lines) {
            const match = line.match(importRegex);
            if (match) {
                const fqn = match[1]; // e.g. "com.example.app.Calculator"
                // Skip standard library imports
                if (stdPrefixes.some(p => fqn.startsWith(p))) continue;
                // Convert dots to path separators and append .java
                imports.push(fqn.replace(/\./g, '/') + '.java');
            }
        }
    } else if (language === 'typescript' || language === 'javascript') {
        const importRegex = /from\s+['"]([^'"]+)['"]/;
        const requireRegex = /require\(['"]([^'"]+)['"]\)/;
        for (const line of lines) {
            let match = line.match(importRegex);
            if (match) {
                imports.push(match[1]);
            } else {
                match = line.match(requireRegex);
                if (match) imports.push(match[1]);
            }
        }
    }
    return imports;
};

export const resolvePath = (currentPath, importPath) => {
    const currentDir = currentPath.split('/').slice(0, -1);
    const parts = importPath.split('/');
    
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
            if (currentDir.length > 0) currentDir.pop();
        } else {
            currentDir.push(part);
        }
    }
    return currentDir.join('/');
};

const flattenFiles = (nodes, map = new Map()) => {
    for (const node of nodes) {
        if (node.isFolder) {
            if (node.children) flattenFiles(node.children, map);
        } else {
            map.set(node.path, node);
        }
    }
    return map;
};

export const resolveDependencies = async (entryFile, rootFiles, getFileContent) => {
    const fileMap = flattenFiles(rootFiles);
    const visited = new Set();
    const queue = [entryFile];
    const result = [];

    visited.add(entryFile.path);

    while (queue.length > 0) {
        const currentFile = queue.shift();
        
        let content;
        try {
            content = await getFileContent(currentFile.path);
        } catch (e) {
            console.warn(`Could not read content for ${currentFile.path}`, e);
            continue;
        }

        if (typeof content !== 'string') continue;

        // If it's not the entry file, add to results
        if (currentFile.path !== entryFile.path) {
            result.push({ name: currentFile.path, content });
        }

        const language = getFileLanguage(currentFile.name);
        const imports = getImports(content, language);

        for (const imp of imports) {
            const candidates = [];
            
            // Strategy 1: Relative path
            // If currentFile.path is 'test-folder/main.cpp', resolvePath returns 'test-folder/test.hpp'
            candidates.push(resolvePath(currentFile.path, imp));
            
            // Strategy 2: Root path (if imp doesn't start with ./ or ../)
            if (!imp.startsWith('./') && !imp.startsWith('../')) {
                candidates.push(imp);
            }

            // Strategy 3: Java package-based resolution.
            // Java imports produce paths like "com/example/app/Calculator.java".
            // The actual file may live under a source root like "src/".
            // We detect the source root from the current file's path and package,
            // and also try common source root prefixes.
            if (language === 'java' && !imp.startsWith('./') && !imp.startsWith('../')) {
                // Detect source root from current file: if currentFile is
                // "src/com/example/HelloWorld.java" and imp is "com/example/app/Calc.java",
                // the source root prefix is "src/".
                const currentDir = currentFile.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
                // Try to find a prefix of currentDir that, combined with imp, matches a file
                const dirParts = currentDir.split('/');
                for (let i = 0; i <= dirParts.length; i++) {
                    const prefix = dirParts.slice(0, i).join('/');
                    const candidate = prefix ? prefix + '/' + imp : imp;
                    if (!candidates.includes(candidate)) {
                        candidates.push(candidate);
                    }
                }
            }

            let foundNode = null;
            for (const candidatePath of candidates) {
                 if (fileMap.has(candidatePath)) {
                     foundNode = fileMap.get(candidatePath);
                     break;
                 }
                 // Try extensions for JS/TS
                 if (!foundNode && (language === 'typescript' || language === 'javascript')) {
                     const extensions = ['.ts', '.tsx', '.js', '.jsx'];
                     for (const ext of extensions) {
                         if (fileMap.has(candidatePath + ext)) {
                             foundNode = fileMap.get(candidatePath + ext);
                             break;
                         }
                     }
                 }
                 if (foundNode) break;
            }
            
            if (foundNode && !visited.has(foundNode.path)) {
                visited.add(foundNode.path);
                queue.push(foundNode);
            } else if (!foundNode) {
                console.warn(`Dependency not found: ${imp} (checked: ${candidates.join(', ')})`);
            }
        }
    }
    
    return result;
};
