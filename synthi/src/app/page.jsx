'use client';

import { useState, useEffect } from 'react';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Github, LogOut, FolderGit2, Plus, Loader2 } from 'lucide-react';

const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

export default function Dashboard() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [workspaces, setWorkspaces] = useState([]);
    const [repoUrl, setRepoUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        if (session?.user?.email) {
            fetchWorkspaces(session.user.email);
        }
    }, [session]);

    const fetchWorkspaces = async (email) => {
        try {
            const res = await fetch(`${COLLAB_SERVER_URL}/workspaces?owner=${encodeURIComponent(email)}`);
            if (res.ok) {
                const data = await res.json();
                setWorkspaces(data);
            }
        } catch (e) {
            console.error("Failed to fetch workspaces", e);
        }
    };

    const handleImport = async (e) => {
        e.preventDefault();
        if (!repoUrl) return;

        setImporting(true);
        try {
            // Generate a random slug
            const slug = Math.random().toString(36).substring(2, 10);
            // Extract repo name from URL for display
            const name = repoUrl.split('/').pop().replace('.git', '');
            
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/clone`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(session?.user?.id && { 'x-user-id': session.user.id }),
                },
                body: JSON.stringify({ 
                    repoUrl,
                    token: session?.accessToken,
                    owner: session?.user?.email,
                    name: name
                })
            });

            if (res.ok) {
                await fetchWorkspaces(session.user.email);
                setRepoUrl('');
                router.push(`/workspace/${slug}`);
            } else {
                const err = await res.json();
                alert(`Import failed: ${err.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error(e);
            alert('Import failed');
        } finally {
            setImporting(false);
        }
    };

    if (status === 'loading') {
        return <div className="flex h-screen items-center justify-center bg-[#1e1e1e] text-white">Loading...</div>;
    }

    if (!session) {
        return (
            <div className="flex h-screen items-center justify-center bg-[#1e1e1e]">
                <Card className="w-[350px] bg-[#252526] border-[#3e3e3e] text-gray-200">
                    <CardHeader>
                        <CardTitle className="text-center">Welcome to Synthi IDE</CardTitle>
                    </CardHeader>
                    <CardContent className="flex justify-center">
                        <Button 
                            onClick={() => signIn('github')}
                            className="bg-[#2da44e] hover:bg-[#2c974b] text-white w-full"
                        >
                            <Github className="mr-2 h-4 w-4" /> Sign in with GitHub
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-gray-200 p-8">
            <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <span className="text-emerald-500">Synthi</span> Dashboard
                    </h1>
                    <div className="flex items-center gap-4">
                        <span className="text-sm text-gray-400">Signed in as {session.user?.name}</span>
                        <Button variant="ghost" size="sm" onClick={() => signOut()}>
                            <LogOut className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Import Section */}
                    <Card className="bg-[#252526] border-[#3e3e3e] text-gray-200">
                        <CardHeader>
                            <CardTitle className="text-lg flex items-center gap-2">
                                <Plus className="h-5 w-5 text-emerald-500" /> Import Repository
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form onSubmit={handleImport} className="space-x-2 flex">
                                <Input 
                                    placeholder="https://github.com/username/repo.git" 
                                    value={repoUrl}
                                    onChange={(e) => setRepoUrl(e.target.value)}
                                    className="bg-[#1e1e1e] border-[#3e3e3e] text-gray-200 flex-1"
                                />
                                <Button 
                                    type="submit" 
                                    disabled={importing || !repoUrl}
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                >
                                    {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Import'}
                                </Button>
                            </form>
                        </CardContent>
                    </Card>

                    {/* Workspaces List */}
                    <Card className="bg-[#252526] border-[#3e3e3e] text-gray-200">
                        <CardHeader>
                            <CardTitle className="text-lg flex items-center gap-2">
                                <FolderGit2 className="h-5 w-5 text-blue-500" /> Your Workspaces
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {workspaces.length === 0 ? (
                                <p className="text-gray-500 text-sm text-center py-4">No workspaces found.</p>
                            ) : (
                                <ul className="space-y-2">
                                    {workspaces.map(ws => (
                                        <li key={ws.slug}>
                                            <Button 
                                                variant="ghost" 
                                                className="w-full justify-start text-left hover:bg-[#2a2d2e] text-gray-300"
                                                onClick={() => router.push(`/workspace/${ws.slug}`)}
                                            >
                                                <span className="font-mono text-xs bg-[#1e1e1e] px-2 py-1 rounded mr-2 text-gray-500">#{ws.slug}</span>
                                                <span className="flex-1 truncate">{ws.name || 'Workspace'}</span>
                                                <span className="text-xs text-gray-600 ml-2">{new Date(ws.createdAt).toLocaleDateString()}</span>
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
