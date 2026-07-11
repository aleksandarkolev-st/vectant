"use client"
import { ChevronRight, Folder, FolderOpen, FileCode2, FileJson, FileType, FileText } from 'lucide-react';

export const ChevronIcon = ({ isOpen, isSelected }) => (
    <ChevronRight
        className={`mr-1 h-3 w-3 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
        style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-muted)' }}
        strokeWidth={2}
    />
);

export const FileIcon = ({ node, isSelected }) => {
    const color = (selected, normal) => isSelected ? selected : normal;

    if (node.isFolder) {
        // Note: node.__open is a side-effect on the prop, replaced with local state in FileItem
        return node.__open? ( 
            <FolderOpen className="mr-2 h-4 w-4" style={{ color: color('var(--text-primary)', 'var(--text-secondary)') }} />
        ) : (
            <Folder className="mr-2 h-4 w-4" style={{ color: color('var(--text-primary)', 'var(--text-secondary)') }} />
        );
    }
    
    // Fallback for file icons
    const name = node.name.toLowerCase();
    if (name.endsWith('.json')) return <FileJson className="mr-2 h-4 w-4" style={{ color: color('var(--accent-success)', 'var(--accent-success)') }} />;
    if (name.endsWith('.md')) return <FileText className="mr-2 h-4 w-4" style={{ color: color('var(--accent-info)', 'var(--accent-info)') }} />;
    if (name.endsWith('.js') || 
        name.endsWith('.ts') || 
        name.endsWith('.tsx')) 
        return <FileCode2 className="mr-2 h-4 w-4" style={{ color: color('var(--accent-warning)', 'var(--accent-warning)') }} />;
    if (name.endsWith('.cpp') || 
        name.endsWith('.h') || 
        name.endsWith('.hpp')) 
        return <FileType className="mr-2 h-4 w-4" style={{ color: color('var(--attention-purple)', 'var(--attention-purple)') }} />;
        
    return <FileText className="mr-2 h-4 w-4" style={{ color: color('var(--text-secondary)', 'var(--text-muted)') }} />;
};
