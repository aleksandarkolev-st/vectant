import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { createGcsStorage, getGcsBucketName } from '@/server/gcsStorage';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';


const storage = createGcsStorage();
const BUCKET_NAME = getGcsBucketName();


export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
        return NextResponse.json({ error: 'An id query parameter is required to fetch workspace.' }, { status: 400 });
    }

    try {
        const workspace = await prisma.workspace.findUnique({
            where: {
                id
            }
        });

        return NextResponse.json(workspace, { status: 200 });
    } catch (error) {
        console.error('Error fetching workspace items:', error);
        return NextResponse.json({ error: 'Failed to retrieve workspace items.' }, { status: 500 });
    }
}

export async function POST(request) {
    try {
        const session = await getServerSession(authOptions);
        const email = session?.user?.email;
        if (!email) {
            return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
        }

        const { name, slug, repoUrl } = await request.json();

        if (!name) {
            return NextResponse.json({ error: 'Workspace name is required.' }, { status: 400 });
        }

        const user = await prisma.user.upsert({
            where: { email },
            update: {},
            create: { email },
            select: { id: true },
        });

        // Use provided slug (collab server) or generate one
        let finalSlug = slug;
        if (!finalSlug) {
            finalSlug = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
        }

        // Create workspace record in DB, include repoUrl if present
        let newWorkspace;
        try {
            newWorkspace = await prisma.workspace.create({
                data: {
                    name,
                    slug: finalSlug,
                    repoUrl: repoUrl || null,
                    memberships: {
                        create: {
                            userId: user.id,
                            role: 'owner',
                        },
                    },
                },
            });
        } catch (dbErr) {
            // Handle unique constraint on slug gracefully
            if (dbErr?.code === 'P2002' && dbErr?.meta?.target && dbErr.meta.target.includes('slug')) {
                const existingWorkspace = await prisma.workspace.findUnique({
                    where: { slug: finalSlug },
                });
                if (existingWorkspace) {
                    return NextResponse.json({ error: 'Workspace slug already exists.' }, { status: 409 });
                }
                return NextResponse.json({ error: 'Workspace slug already exists.' }, { status: 409 });
            }
            throw dbErr;
        }

        const rootFolderPath = `workspaces/${finalSlug}/`;
        const bucket = storage.bucket(BUCKET_NAME);
        
        try {
            await bucket.file(rootFolderPath).save('', {
                contentType: 'application/x-directory',
                resumable: false,
                metadata: {
                    cacheControl: 'no-cache',
                    metadata: {
                        isFolder: 'true',
                        name: newWorkspace.name,
                        createdBy: 'synthi-ide',
                        isMarker: 'true'
                    }
                }
            });
        } catch (err) {
            // Log the error but do not remove workspace; return 201 since DB now has workspace
            console.warn('Failed to create GCS marker folder for workspace', finalSlug, err?.message || err);
        }

        return NextResponse.json(newWorkspace, { status: 201 });
    } catch (error) {
        console.error('Error creating workspace item:', error);
        return NextResponse.json({ error: 'Failed to create workspace item.' }, { status: 500 });
    }
}

export async function PUT(request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
        return NextResponse.json({ error: 'Item ID is required in the query parameters for updating.' }, { status: 400 });
    }

    try {
        const { name } = await request.json();

        if (!name) {
            return NextResponse.json({ error: 'At least one field (name or parentId) is required for update.' }, { status: 400 });
        }

        const updatedItem = await prisma.workspace.update({
            where: { id },
            data: { name },
        });

        return NextResponse.json(updatedItem, { status: 200 });
    } catch (error) {
        if (error instanceof Error && error.code === 'P2025') {
            return NextResponse.json({ error: 'Workspace item not found.' }, { status: 404 });
        }
        console.error('Error updating workspace item:', error);
        return NextResponse.json({ error: 'Failed to update workspace item.' }, { status: 500 });
    }
}

export async function DELETE(request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
        return NextResponse.json({ error: 'Workspace ID is required in the query parameters for deletion.' }, { status: 400 });
    }

    try {
        const storagePathPrefix = `workspaces/${id}/`;
        
        await storage.bucket(BUCKET_NAME).deleteFiles({
            prefix: storagePathPrefix,
            force: true, 
        });

        await prisma.workspace.delete({
            where: { id },
        });

        return NextResponse.json({ message: 'Workspace deleted successfully.' }, { status: 200 });
    } catch (error) {
        if (error instanceof Error && error.code === 'P2025') {
            return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
        }
        console.error('Error deleting workspace:', error);
        return NextResponse.json({ error: 'Failed to delete workspace.' }, { status: 500 });
    }
}
