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
        await git.commit(message);
        return this.getStatus(slug);
    }

    async stageFile(slug, filePath) {
        const git = this.getGit(slug);
        await git.add(filePath);
        return this.getStatus(slug);
    }

    async unstageFile(slug, filePath) {
        const git = this.getGit(slug);
        try {
            await git.reset(['HEAD', filePath]);
        } catch (e) {
            // Fallback for initial commit or if HEAD is invalid
            await git.rm(['--cached', filePath]);
        }
        return this.getStatus(slug);
    }

    async push(slug) {
        const git = this.getGit(slug);
        try {
            await git.push();
        } catch (e) {
            // If push fails, try setting upstream
            if (e.message.includes('no upstream branch') || e.message.includes('set-upstream')) {
                const branchSummary = await git.branchLocal();
                const currentBranch = branchSummary.current;
                if (currentBranch) {
                    await git.push('origin', currentBranch, ['--set-upstream']);
                } else {
                    throw e;
                }
            } else {
                throw e;
            }
        }
        return this.getStatus(slug);
    }

    async pull(slug) {
        const git = this.getGit(slug);
        await git.pull();
        return this.getStatus(slug);
    }

    async discardChange(slug, filePath) {
        const git = this.getGit(slug);
        // Check if file is untracked
        const status = await git.status();
        const fileStatus = status.files.find(f => f.path === filePath);
        
        if (fileStatus && fileStatus.index === '?') {
            // Untracked file, delete it
            const repoPath = this.getRepoPath(slug);
            const fullPath = path.join(repoPath, filePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        } else {
            await git.checkout(filePath);
        }
        return this.getStatus(slug);
    }

    async getDiff(slug, filePath) {
        const git = this.getGit(slug);
        if (filePath) {
            return await git.diff([filePath]);
        }
        return await git.diff();
    }

    async getLog(slug) {
        const git = this.getGit(slug);
        return await git.log();
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

    async listFiles(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) return [];
        
        const getFiles = (dir, baseDir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                if (file === '.git') return;
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(getFiles(filePath, baseDir));
                } else {
                    results.push(path.relative(baseDir, filePath).replace(/\\/g, '/'));
                }
            });
            return results;
        };
        
        return getFiles(repoPath, repoPath);
    }

    async readFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        if (fs.existsSync(fullPath)) {
            return fs.readFileSync(fullPath, 'utf-8');
        }
        throw new Error('File not found');
    }

    async getFileContent(slug, filePath, ref = 'HEAD') {
        const git = this.getGit(slug);
        try {
            // Ensure forward slashes for git command and remove leading slash
            let gitPath = filePath.replace(/\\/g, '/');
            if (gitPath.startsWith('/')) gitPath = gitPath.substring(1);
            
            // Use raw show command to avoid simple-git parsing issues
            return await git.raw(['show', `${ref}:${gitPath}`]);
        } catch (e) {
            console.error(`Error fetching content for ${ref}:${filePath}`, e.message);
            try {
                // Fallback: try cat-file -p which is plumbing and might be more robust
                let gitPath = filePath.replace(/\\/g, '/');
                if (gitPath.startsWith('/')) gitPath = gitPath.substring(1);
                return await git.raw(['cat-file', '-p', `${ref}:${gitPath}`]);
            } catch (e2) {
                console.error(`Fallback cat-file failed for ${ref}:${filePath}`, e2.message);
                return '';
            }
        }
    }
}

module.exports = new GitService(path.join(__dirname, 'repos'));
