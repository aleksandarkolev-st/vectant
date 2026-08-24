import { NextResponse } from 'next/server';
import { createGcsStorage, getGcsBucketName } from '@/server/gcsStorage';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';

const storage = createGcsStorage();

const BUCKET_NAME = getGcsBucketName('my-workspace-content-bucket');

function badRequest(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

function normalizeWorkspaceItemPath(value, { allowFolder = true, requireFile = false } = {}) {
    if (typeof value !== 'string') {
        throw badRequest('Workspace item path is required.');
    }

    const raw = value.trim();
    if (!raw) {
        throw badRequest('Workspace item path is required.');
    }
    if (/[\0-\x1f\x7f]/.test(raw)) {
        throw badRequest('Workspace item path contains control characters.');
    }
    if (raw.includes('\\')) {
        throw badRequest('Workspace item path must use forward slashes.');
    }
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
        throw badRequest('Workspace item path must be relative.');
    }

    const isFolder = raw.endsWith('/');
    if (isFolder && (!allowFolder || requireFile)) {
        throw badRequest('Workspace item path must refer to a file.');
    }

    const segments = raw.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        throw badRequest('Workspace item path is required.');
    }
    for (const segment of segments) {
        if (segment === '.' || segment === '..') {
            throw badRequest('Workspace item path cannot contain traversal segments.');
        }
    }

    return `${segments.join('/')}${isFolder ? '/' : ''}`;
}

async function requireAuthorizedWorkspace(workspaceId) {
    if (!workspaceId) {
        return { ok: false, response: NextResponse.json({ error: 'Workspace ID is required.' }, { status: 400 }) };
    }

    const access = await requireWorkspaceAccess(workspaceId);
    if (!access.ok) {
        return { ok: false, response: NextResponse.json({ error: access.error }, { status: access.status }) };
    }

    return {
        ok: true,
        workspaceSlug: access.workspace?.slug || workspaceId,
        membership: access.membership,
    };
}

/**
 * Real Prisma workspace members (owner/admin/member) can already do anything
 * this route allows — this only narrows a live collab-session guest down to
 * whatever the host actually granted them (canEdit for content writes,
 * canFileOps for create/rename/delete). See requireWorkspaceAccess() /
 * collabGuestAccess.js for where `membership.role === 'collab-guest'` and
 * `collabPermissions` come from.
 */
function requireCollabPermission(workspace, requiredPermission) {
    if (workspace.membership?.role !== 'collab-guest') return null;
    if (workspace.membership.collabPermissions?.[requiredPermission] === true) return null;
    const error = new Error(`Forbidden: missing ${requiredPermission} permission`);
    error.status = 403;
    return error;
}

export async function GET(request, { params }) {
    const data = await params;
    const workspaceId = data.slug;
    const searchParams = request.nextUrl.searchParams;
    let filePath;

    try {
        const workspace = await requireAuthorizedWorkspace(workspaceId);
        if (!workspace.ok) {
            return workspace.response;
        }

        filePath = normalizeWorkspaceItemPath(searchParams.get('filePath'), { requireFile: true });
        const gcsFilePath = `workspaces/${workspace.workspaceSlug}/${filePath}`;

        const file = storage.bucket(BUCKET_NAME).file(gcsFilePath);
        const [exists] = await file.exists();

        if (!exists) {
            return NextResponse.json({ error: `File not found: ${filePath}` }, { status: 404 });
        }

        const [metadata] = await file.getMetadata();

        const fileStream = file.createReadStream();

        const webStream = new ReadableStream({
            start(controller) {
                fileStream.on('data', (chunk) => {
                    controller.enqueue(chunk);
                });
                fileStream.on('end', () => {
                    controller.close();
                });
                fileStream.on('error', (err) => {
                    console.error('Stream error:', err);
                    controller.error(err);
                });
            },
            cancel() {
                fileStream.destroy();
            }
        });

        return new Response(webStream, {
            status: 200,
            headers: {
                'Content-Type': metadata.contentType || 'application/octet-stream',
                'Content-Length': metadata.size,
            },
        });

    } catch (error) {
        const status = error.status || (error.message.startsWith('Forbidden') ? 403 : (error.message.includes('required') ? 400 : 500));
        console.error('API Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error during file retrieval.' }, { status });
    }
}

export async function POST(request, { params }) {
    const data = await params;
    const workspaceId = data.slug;

    try {
        const workspace = await requireAuthorizedWorkspace(workspaceId);
        if (!workspace.ok) {
            return workspace.response;
        }

        const formData = await request.formData();
        const filePath = normalizeWorkspaceItemPath(formData.get('filePath'));
        const fileContent = formData.get('file');

        const permissionError = requireCollabPermission(workspace, filePath.endsWith('/') ? 'canFileOps' : 'canEdit');
        if (permissionError) throw permissionError;

        const gcsFilePath = `workspaces/${workspace.workspaceSlug}/${filePath}`;
        const file = storage.bucket(BUCKET_NAME).file(gcsFilePath);

        if (filePath.endsWith('/')) {
            const [exists] = await file.exists();
            if (exists) {
                return NextResponse.json({ error: `Folder already exists: ${filePath}` }, { status: 409 });
            }

            await file.save('', {
                contentType: 'application/x-directory',
                resumable: false,
                metadata: {
                    cacheControl: 'no-cache',
                    metadata: {
                        isFolder: 'true',
                        name: filePath.split('/').filter(Boolean).slice(-1)[0] + "/",
                        path: filePath,
                        createdBy: 'synthi-ide',
                        isMarker: 'true'
                    }
                }
            });

            return NextResponse.json({ 
                message: `Folder created successfully: ${filePath}`, 
                path: filePath 
            }, { status: 201 });

        } else {
            if (!fileContent || typeof fileContent.stream !== 'function') {
                return NextResponse.json({ error: 'file field is required for file uploads.' }, { status: 400 });
            }
            const contentType = request.headers.get('content-type') || 'application/octet-stream';
            
            const writeStream = file.createWriteStream({
                metadata: {
                    contentType: contentType,
                    metadata: {
                        originalName: file.name,
                    }
                },
                resumable: false,
            });

            const readableStream = fileContent.stream();

            await new Promise((resolve, reject) => {
                readableStream.pipeTo(new WritableStream({
                    write(chunk) {
                        writeStream.write(chunk);
                    },
                    close() {
                        writeStream.end(resolve);
                    },
                    abort(reason) {
                        writeStream.destroy(reason);
                        reject(reason);
                    }
                })).catch(reject); 

                writeStream.on('error', reject);
                writeStream.on('finish', resolve);
            });

            return NextResponse.json({ 
                message: `File uploaded successfully to: ${filePath}`, 
                path: filePath 
            }, { status: 201 });
        }

    } catch (error) {
        const status = error.status || (error.message.startsWith('Forbidden') ? 403 : (error.message.includes('required') ? 400 : 500));
        console.error('GCS POST Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error during file creation.' }, { status });
    }
}

export async function PUT(request, { params }) {
    const data = await params;
    const workspaceId = data.slug;

    try {
        const workspace = await requireAuthorizedWorkspace(workspaceId);
        if (!workspace.ok) {
            return workspace.response;
        }

        const body = await request.json();
        const itemPath = normalizeWorkspaceItemPath(body.itemPath);
        const newPath = body.newPath ? normalizeWorkspaceItemPath(body.newPath) : '';

        const permissionError = requireCollabPermission(workspace, newPath ? 'canFileOps' : 'canEdit');
        if (permissionError) throw permissionError;

        if (newPath) {
            
            if (itemPath.endsWith('/') !== newPath.endsWith('/')) {
                return NextResponse.json({ error: 'Cannot change item type during rename (e.g., folder to file or vice versa).' }, { status: 400 });
            }

            const isFolder = itemPath.endsWith('/');
            const oldGcsPath = `workspaces/${workspace.workspaceSlug}/${itemPath}`;
            const newGcsPath = `workspaces/${workspace.workspaceSlug}/${newPath}`;

            if (isFolder) {
                
                const [files] = await storage.bucket(BUCKET_NAME).getFiles({
                    prefix: oldGcsPath,
                    autoPaginate: true, 
                });

                if (files.length === 0) {
                    const [exists] = await storage.bucket(BUCKET_NAME).file(oldGcsPath).exists();
                    if (!exists) {
                        return NextResponse.json({ error: `Folder not found: ${itemPath}` }, { status: 404 });
                    }
                }

                const movePromises = files.map(file => {
                    const destinationPath = file.name.replace(oldGcsPath, newGcsPath);
                    return file.move(destinationPath);
                });

                await Promise.all(movePromises);

                return NextResponse.json({ 
                    message: `Folder successfully renamed from ${itemPath} to ${newPath}.`,
                    oldPath: itemPath,
                    newPath: newPath
                }, { status: 200 });

            } else {
                const file = storage.bucket(BUCKET_NAME).file(oldGcsPath);
                const [exists] = await file.exists();

                if (!exists) {
                    return NextResponse.json({ error: `File not found: ${itemPath}` }, { status: 404 });
                }

                await file.move(newGcsPath);

                return NextResponse.json({ 
                    message: `File successfully renamed from ${itemPath} to ${newPath}.`,
                    oldPath: itemPath,
                    newPath: newPath
                }, { status: 200 });
            }

        } else {
            if (itemPath.endsWith('/')) {
                 return NextResponse.json({ error: 'Cannot PUT folder content. PUT is only for file content updates.' }, { status: 400 });
            }

            const gcsFilePath = `workspaces/${workspace.workspaceSlug}/${itemPath}`;
            const file = storage.bucket(BUCKET_NAME).file(gcsFilePath);
            
            const contentType = request.headers.get('content-type') || 'application/octet-stream';
            
            const writeStream = file.createWriteStream({
                metadata: {
                    contentType: contentType,
                },
                resumable: false,
            });

            await new Promise((resolve, reject) => {
                request.body.pipeTo(new WritableStream({
                    write(chunk) {
                        writeStream.write(chunk);
                    },
                    close() {
                        writeStream.end(resolve);
                    },
                    abort(reason) {
                        writeStream.destroy(reason);
                        reject(reason);
                    }
                })).catch(reject);

                writeStream.on('error', reject);
                writeStream.on('finish', resolve);
            });

            return NextResponse.json({ 
                message: `File updated successfully at: ${itemPath}`, 
                path: itemPath 
            }, { status: 200 }); 
        }

    } catch (error) {
        const status = error.status || (error.message.startsWith('Forbidden') ? 403 : (error.message.includes('required') ? 400 : 500));
        console.error('GCS PUT Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error during update or rename.' }, { status });
    }
}


export async function DELETE(request, { params }) {
    const data = await params;
    const workspaceId = data.slug;

    try {
        const workspace = await requireAuthorizedWorkspace(workspaceId);
        if (!workspace.ok) {
            return workspace.response;
        }

        const body = await request.json();
        const itemPath = normalizeWorkspaceItemPath(body.itemPath);

        const permissionError = requireCollabPermission(workspace, 'canFileOps');
        if (permissionError) throw permissionError;

        const gcsFilePath = `workspaces/${workspace.workspaceSlug}/${itemPath}`;

        if (itemPath.endsWith('/')) {
            // For folders, we don't check if a folder "object" exists because
            // GCS folders are virtual - they exist only as prefixes of files.
            // Just delete all files with this prefix.
            const prefix = gcsFilePath;
            
            const [filesToDelete] = await storage.bucket(BUCKET_NAME).getFiles({
                prefix: prefix,
            });
            
            if (filesToDelete.length === 0) {
                // No files found with this prefix - folder doesn't exist
                return NextResponse.json({ error: `Folder not found: ${itemPath}` }, { status: 404 });
            }
            
            await Promise.allSettled(filesToDelete.map(file => file.delete({ ignoreNotFound: true })));

            // Also try to delete the folder marker object if it exists
            const folderMarker = storage.bucket(BUCKET_NAME).file(gcsFilePath);
            try {
                await folderMarker.delete({ ignoreNotFound: true });
            } catch (markerError) {
                // Ignore - marker might not exist
            }

            return NextResponse.json({ 
                message: `${filesToDelete.length} items deleted successfully(${itemPath}).`, 
                path: itemPath 
            }, { status: 200 });

        } else {
            // For files, check existence first
            const item = storage.bucket(BUCKET_NAME).file(gcsFilePath);
            const [exists] = await item.exists();
            if (!exists) {
                return NextResponse.json({ error: `File not found: ${itemPath}` }, { status: 404 });
            }
            
            await item.delete();

            return NextResponse.json({ 
                message: `File deleted successfully: ${itemPath}`, 
                path: itemPath 
            }, { status: 200 }); 
        }

    } catch (error) {
        const status = error.status || (error.message.startsWith('Forbidden') ? 403 : (error.message.includes('required') ? 400 : 500));
        console.error('GCS DELETE Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error during file deletion.' }, { status });
    }
}
