/**
 * Determines the file language for Monaco Editor based on the file extension.
 * @param {string} fileName 
 * @returns {string} The language ID.
 */
export const getFileLanguage = (fileName) => {
    const extension = fileName.split('.').pop()?.toLowerCase();
    const languageMap = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'java': 'java',
        'kt': 'kotlin',
        'kts': 'kotlin',
        'dart': 'dart',
        'cpp': 'cpp',
        'c': 'c',
        'cs': 'csharp',
        'php': 'php',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'html': 'html',
        'css': 'css',
        'scss': 'scss',
        'json': 'json',
        'xml': 'xml',
        'md': 'markdown',
        'txt': 'plaintext',
        'sql': 'sql',
        'sh': 'shell',
        'yml': 'yaml',
        'yaml': 'yaml'
    };
    return languageMap[extension] || 'plaintext';
};


/**
 * Finds a file in the recursive tree and updates its content (used for local caching).
 * @param {Array<Node>} currentFiles - The current file tree structure.
 * @param {Object} targetFile - The file object to update.
 * @param {string} newContent - The new content string.
 * @returns {Array<Node>} A new array with the file content updated immutably.
 */
export const findFileAndUpdate = (currentFiles, targetFile, newContent) => {
    return currentFiles.map(item => {
        if (!item.isFolder && item.path === targetFile.path) {
            return {...item, content: newContent };
        }
        if (item.isFolder && item.children) {
            return {...item, children: findFileAndUpdate(item.children, targetFile, newContent) };
        }
        return item;
    });
};



/**
 * Finds the first actual file in the tree for initial selection.
 * @param {Array<Node>} nodes - File tree nodes.
 * @returns {Object | null} The first file node found.
 */
export const findFirstFile = (nodes) => {
    for (const node of nodes) {
        if (!node.isFolder) {
            return node;
        }
        if (node.isFolder && node.children) {
            const found = findFirstFile(node.children);
            if (found) return found;
        }
    }
    return null;
};

// TO DO: MERGE findFileInTree and findFolderInTree into a single function with a type parameter.

/**
 * Recursively finds a file by its full path for existence check (Creation validation).
 * @param {Array<Node>} nodes - File tree nodes.
 * @param {string} filePath - Full path of the file to find (e.g., "folder1/folder2/file.txt").
 * @returns {Object | null} The file node found.
 */
export const findFileInTree = (nodes, filePath) => {
    for (const node of nodes) {
        if (!node.isFolder && node.path === filePath) {
            return node;
        }
        if (node.isFolder && node.children) {
            const found = findFileInTree(node.children, filePath);
            if (found) return found;
        }
    }
    return null;
};


/**
 * Recursively finds a folder by its full path for existence check (Creation validation).
 * @param {Array<Node>} nodes - File tree nodes.
 * @param {string} folderPath - Full path of the folder to find (e.g., "folder1/folder2").
 * @returns {Object | null} The folder node found.
 */
export const findFolderInTree = (nodes, folderPath) => {
    for (const node of nodes) {
        if (node.isFolder && node.path === folderPath) {
            return node;
        }
        if (node.isFolder && node.children) {
            const found = findFolderInTree(node.children, folderPath);
            if (found) return found;
        }
    }
    return null;
};


export const getItemPathInBucket = (item) => {
    return item.path + (item.isFolder ? '/' : '');
}

export const getTargetFolder = (activeFile, filesTree) => {
  // Safety check: ensure filesTree is an array
  if (!filesTree || !Array.isArray(filesTree)) {
    console.warn('filesTree is not an array:', filesTree);
    return null;
  }
  
  if (!activeFile) return null;
  
  // If active file is a folder, use it
  if (activeFile.isFolder) {
    return activeFile;
  }
  
  // Otherwise, find the parent folder
  const findParentFolder = (nodes, targetPath) => {
    if (!Array.isArray(nodes)) return null;
    
    for (const node of nodes) {
      if (node.isFolder && node.children && Array.isArray(node.children)) {
        // Check if this folder contains the target file
        const hasChild = node.children.some(child => child.path === targetPath);
        if (hasChild) {
          return node;
        }
        // Recursively search in children
        const found = findParentFolder(node.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  };
  
  return findParentFolder(filesTree, activeFile.path);
};