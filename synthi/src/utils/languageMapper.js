// src/utils/languageMapper.js
/**
 * Maps file extensions to Monaco Editor language identifiers
 * @param {string} fileName - The name of the file
 * @returns {string} - Monaco language identifier
 */
export const getMonacoLanguage = (fileName) => {
  if (!fileName) return 'plaintext';
  
  const extension = fileName.split('.').pop()?.toLowerCase();
  
  const languageMap = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    
    // C/C++
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    
    // Python
    'py': 'python',
    'pyw': 'python',
    'pyx': 'python',
    
    // Java
    'java': 'java',
    
    // C#
    'cs': 'csharp',
    
    // PHP
    'php': 'php',
    
    // Ruby
    'rb': 'ruby',
    
    // Go
    'go': 'go',
    
    // Rust
    'rs': 'rust',
    
    // Kotlin
    'kt': 'kotlin',
    'kts': 'kotlin',
    
    // Dart
    'dart': 'dart',
    
    // Zig
    'zig': 'zig',
    
    // Lua
    'lua': 'lua',
    
    // Elixir
    'ex': 'elixir',
    'exs': 'elixir',
    
    // Svelte
    'svelte': 'svelte',
    
    // Swift
    'swift': 'swift',
    
    // Scala
    'scala': 'scala',
    'sc': 'scala',
    
    // Haskell
    'hs': 'haskell',
    
    // Shell
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'bat': 'bat',
    'cmd': 'bat',
    'ps1': 'powershell',
    
    // SQL
    'sql': 'sql',
    
    // Markdown
    'md': 'markdown',
    'markdown': 'markdown',
    
    // JSON
    'json': 'json',
    
    // YAML
    'yaml': 'yaml',
    'yml': 'yaml',
    
    // XML
    'xml': 'xml',
    
    // Config files
    'toml': 'toml',
    'ini': 'ini',
    'conf': 'plaintext',
    'config': 'plaintext',
    
    // Vue/Svelte
    'vue': 'html',
    'svelte': 'html',
    
    // Text
    'txt': 'plaintext',
    'log': 'plaintext',
    
    // Docker
    'dockerfile': 'dockerfile',
    
    // Assembly
    'asm': 'plaintext',
    's': 'plaintext',
  };
  
  // Check for special filenames
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === 'dockerfile') return 'dockerfile';
  if (lowerFileName === 'makefile') return 'makefile';
  if (lowerFileName.startsWith('.env')) return 'plaintext';
  if (lowerFileName === '.gitignore') return 'plaintext';
  
  return languageMap[extension] || 'plaintext';
};