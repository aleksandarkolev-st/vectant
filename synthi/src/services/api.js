// src/services/api.js

import SynthiException from "@/components/SynthiException";

export class ApiClient {
    constructor(baseUrl = '/api/workspace') {
        this.baseUrl = baseUrl;
    }

    async _handleResponse(response) {
        if (!response.ok) {
            let errorData = {};
            try {
                errorData = await response.json();
            } catch (e) {
                // Ignore if response isn't JSON
            }
            throw new SynthiException(errorData.error || `API Error: ${response.statusText}`, `Status: ${response.status}`);
        }
        return response;
    }

    // READ
    async fetchFiles(slug) {
        const response = await fetch(`${this.baseUrl}/${slug}`);
        const data = await this._handleResponse(response).then(r => r.json());
        // Simulating the tree structure creation here (or it happens in a selector)
        return data.files;
    }

    async fetchFileContent(slug, filePath) {
        const response = await fetch(`${this.baseUrl}/${slug}/item?filePath=${encodeURIComponent(filePath)}`);
        return this._handleResponse(response).then(r => r.text());
    }

    // MUTATIONS (Write Operations)
    async saveFileContent(slug, filePath, content, fileName) {
        const formData = new FormData();
        const blob = new Blob([content], { type: 'text/plain' });
        formData.append('file', blob, fileName);
        formData.append('filePath', filePath);
      
        // This runs in background, retuning an early positive -> IIFE
        (async () => {
          try {
            const res = await fetch(`${this.baseUrl}/${slug}/item/`, {
              method: 'POST',
              body: formData,
            });
            await this._handleResponse(res);
          } catch (err) {
            console.error('Background save failed:', err);
          }
        })();
        return { ok: true, optimistic: true };
    }

    async createItem(slug, fullPath, isFolder) {
        const formData = new FormData();
        // Extract file name from full path for blob append
        const fileName = fullPath.split('/').pop();
        const blob = new Blob([''], { type: 'text/plain' });
        formData.append('file', blob, fileName);
        formData.append('filePath', isFolder ? `${fullPath}/` : fullPath);

        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'POST',
            body: formData,
        });
        return this._handleResponse(response);
    }

    async renameItem(slug, itemPath, newPath) {
        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemPath, newPath }),
        });
        return this._handleResponse(response);
    }

    async deleteItem(slug, itemPath) {
        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemPath }),
        });
        return this._handleResponse(response);
    }
}

export const api = new ApiClient();
