const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');

class GitService {
    constructor(baseDir) {
        this.baseDir = baseDir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    getRepoPath(slug) {
        return path.join(this.baseDir, slug);
    }

    getGit(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) {
            throw new Error(`Repository for slug ${slug} not found`);
        }
        return simpleGit(repoPath);
    }

    async initRepo(slug, remoteUrl) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) {
            fs.mkdirSync(repoPath, { recursive: true });
            const git = simpleGit(repoPath);
            await git.init();
            if (remoteUrl) {
                await git.addRemote('origin', remoteUrl);
            }
        }
        return { success: true, path: repoPath };
    }

    async cloneRepo(slug, repoUrl, token) {
        const repoPath = this.getRepoPath(slug);
        if (fs.existsSync(repoPath)) {
            throw new Error(`Repository for slug ${slug} already exists`);
        }
        
        let urlToClone = repoUrl;
        // Inject token if provided and it's a GitHub URL
        if (token && repoUrl.startsWith('https://github.com/')) {
             urlToClone = repoUrl.replace('https://', `https://${token}@`);
        }
        
        await simpleGit().clone(urlToClone, repoPath);
        return { success: true, path: repoPath };
    }

    async listWorkspaces() {
        if (!fs.existsSync(this.baseDir)) return [];
        const dirents = fs.readdirSync(this.baseDir, { withFileTypes: true });
        return dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }

    async getStatus(slug) {
        try {
            const git = this.getGit(slug);
            return await git.status();
        } catch (e) {
            console.error("Git status error:", e);
            return null;
        }
    }

    async getBranches(slug) {
        try {
            const git = this.getGit(slug);
            const localSummary = await git.branchLocal();
            const allSummary = await git.branch(['-a']);
            return { 
                local: localSummary.all, 
                current: localSummary.current,
                all: allSummary.all 
            };
        } catch (e) {
            console.error("Get branches error:", e);
            return { local: [], current: '', all: [] };
        }
    }

    async checkout(slug, branchName, create = false) {
        const git = this.getGit(slug);
        if (create) {
            await git.checkoutLocalBranch(branchName);
        } else {
            await git.checkout(branchName);
        }
        return this.getStatus(slug);
    }

    async fetch(slug) {
        const git = this.getGit(slug);
        await git.fetch();
        return this.getStatus(slug);
    }

    async commit(slug, message) {
        const git = this.getGit(slug);
        await git.add('.');
        await git.commit(message);
        return this.getStatus(slug);
    }

    async push(slug) {
        const git = this.getGit(slug);
        await git.push();
        return this.getStatus(slug);
    }

    async syncFile(slug, filePath, content) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content);
    }
    
    async deleteFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    }
}

module.exports = new GitService(path.join(__dirname, 'repos'));
