import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';
import { createGcsStorage, getGcsBucketName } from '@/server/gcsStorage';

const storage = createGcsStorage();

const BUCKET_NAME = getGcsBucketName();

function buildFileTree(flatFiles, prefixLength) {
    const root = { name: 'root', isFolder: true, children: [], path: '' };

    flatFiles.forEach(file => {
        // The path relative to the workspace root (e.g., 'folder/file.txt' or 'folder/')
        const relativePath = file.name.substring(prefixLength);
        if (!relativePath) return; 

        // Filter(Boolean) handles trailing slashes by removing the final empty segment
        const parts = relativePath.split('/').filter(Boolean);
        
        let currentNode = root;
        let cumulativePath = '';

        for (let i = 0; i < parts.length; i++) {
            const partName = parts[i];
            const isLastPart = (i === parts.length - 1);
            
            // Determine if the current part represents a folder (true if it's not the last part, or if the original file path ends with a slash)
            const isFolder = !isLastPart || file.name.endsWith('/'); 
            
            // Build the cumulative path for the current part
            // Example: "folder" -> "folder/file"
            cumulativePath = cumulativePath ? `${cumulativePath}/${partName}` : partName;

            // Look up existing child using the segment name (partName)
            let child = currentNode.children.find(c => c.name === partName);
            
            if (!child) {
                // Create new node with segment name (no slash added to name property)
                child = {
                    name: partName, // Corrected: Name is just the segment (e.g., "testFolder")
                    path: cumulativePath,
                    isFolder: isFolder,
                    children: isFolder ? [] : undefined,
                };
                
                if (!isFolder && isLastPart) {
                    child.size = file.metadata.size;
                    child.contentType = file.metadata.contentType;
                    child.updated = file.metadata.updated;
                }
                currentNode.children.push(child);
            }
            
            // Traverse to the next node if it's a folder
            if (isFolder) {
                 currentNode = child;
            }
        }
    });

    return root.children;
}


export async function GET(request, { params }) {
    const data = await params;
    const workspaceId = data.workspaceId;

    if (!workspaceId) {
        return NextResponse.json({ error: 'Workspace ID is required.' }, { status: 400 });
    }

    let access;
    try {
        access = await requireWorkspaceAccess(workspaceId);
    } catch (error) {
        console.error('Workspace access check failed:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const workspaceMeta = {
        id: access.workspace?.id,
        slug: access.workspace?.slug || workspaceId,
        name: access.workspace?.name || workspaceId,
    };

    const storagePathPrefix = `workspaces/${workspaceId}/`;

    try {
        const [files] = await storage.bucket(BUCKET_NAME).getFiles({
            prefix: storagePathPrefix,
            autoPaginate: true, 
        });

        // Check if empty (or only contains the marker folder itself) and try to sync from collab server
        // The marker folder is stored as an object with name ending in '/' (e.g. "workspaces/slug/")
        // If files.length === 1 and it's the folder itself, we should treat it as empty and sync.
        const isEmpty = files.length === 0 || (files.length === 1 && files[0].name === storagePathPrefix);

        if (isEmpty) {
             const COLLAB_SERVER_URL = process.env.COLLAB_SERVER_URL || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
             try {
                 const res = await fetch(`${COLLAB_SERVER_URL}/git/${workspaceId}/files`);
                 if (res.ok) {
                     const fileList = await res.json();
                     if (Array.isArray(fileList) && fileList.length > 0) {
                         console.log(`Syncing ${fileList.length} files from collab server for ${workspaceId}`);
                         
                         // Upload files in parallel
                         await Promise.all(fileList.map(async (filePath) => {
                             try {
                                 const contentRes = await fetch(`${COLLAB_SERVER_URL}/git/${workspaceId}/file?path=${encodeURIComponent(filePath)}`);
                                 if (contentRes.ok) {
                                     const contentData = await contentRes.json();
                                     const content = contentData.content;
                                     
                                     const gcsFilePath = `workspaces/${workspaceId}/${filePath}`;
                                     await storage.bucket(BUCKET_NAME).file(gcsFilePath).save(content);
                                 }
                             } catch (err) {
                                 console.error(`Failed to sync file ${filePath}:`, err);
                             }
                         }));
                         
                         // Re-fetch files
                         const [refreshedFiles] = await storage.bucket(BUCKET_NAME).getFiles({
                            prefix: storagePathPrefix,
                            autoPaginate: true, 
                        });
                        const fileTree = buildFileTree(refreshedFiles, storagePathPrefix.length);
                        return NextResponse.json({ files: fileTree, workspace: workspaceMeta }, { status: 200 });
                     }
                 }
             } catch (e) {
                 console.warn("Failed to sync from collab server:", e);
             }
        }

        const prefixLength = storagePathPrefix.length;
        const fileTree = buildFileTree(files, prefixLength);

        return NextResponse.json({ files: fileTree, workspace: workspaceMeta }, { status: 200 });

    } catch (error) {
        console.error('GCS Listing Error:', error);
        return NextResponse.json({ error: 'Internal server error during content listing.' }, { status: 500 });
    }
}
