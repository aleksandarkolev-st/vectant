const fs = require('fs');
const path = require('path');

class WorkspaceManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.workspaces = [];
        this.load();
    }

    load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const data = fs.readFileSync(this.filePath, 'utf-8');
                this.workspaces = JSON.parse(data);
            } catch (e) {
                console.error("Failed to load workspaces metadata", e);
                this.workspaces = [];
            }
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2));
        } catch (e) {
            console.error("Failed to save workspaces metadata", e);
        }
    }

    addWorkspace(slug, repoUrl, owner, name) {
        const existing = this.workspaces.find(w => w.slug === slug);
        if (existing) return;

        this.workspaces.push({
            slug,
            repoUrl,
            owner, // email or username
            name: name || slug,
            createdAt: new Date().toISOString()
        });
        this.save();
    }

    getWorkspaces(owner) {
        if (!owner) return this.workspaces;
        return this.workspaces.filter(w => w.owner === owner);
    }
    
    getAllWorkspaces() {
        return this.workspaces;
    }
}

module.exports = new WorkspaceManager(path.join(__dirname, 'workspaces.json'));
