# Container-First Architecture for File Consistency

## Overview

This document describes the Container-First architecture implemented to solve "ghost errors" - stale diagnostics that persist after applying AI suggestions.

## Problem Statement

The original architecture had a disconnect between:
1. **Editor Content** - What the user sees in Monaco editor
2. **Redux Content** - Cached content in frontend state
3. **Y.js Content** - Real-time collaboration content
4. **Server Disk Content** - What the compiler/AI actually analyzes

This caused diagnostics to be generated from stale content, resulting in errors that:
- Appeared after fixes were applied
- Didn't match the current code
- Were impossible to reproduce

## Solution: Server is Source of Truth

The new architecture ensures that:

> **The compiler, AI, and Git ALL read from the same container filesystem.**
> **The client NEVER sends content for analysis - it only sends file paths.**

## Architecture Components

### 1. Auto-Flush Mechanism (Collab Server)

**File:** `backend/collab-server/server.js`

Every Y.js text change triggers a debounced disk write:

```javascript
// ValidatingPersistence._setupAutoFlush()
const observer = () => {
  if (flushTimer) clearTimeout(flushTimer);
  
  flushTimer = setTimeout(async () => {
    const content = targetText.toString();
    await fs.writeFile(fullPath, content, 'utf-8');
    console.log(`[Collab AutoFlush] ${filePath} -> disk`);
  }, 150); // 150ms debounce
};

targetText.observe(observer);
```

**Flow:**
1. User types in Monaco editor
2. Y.js `Text` type updates
3. Observer fires
4. After 150ms debounce, content is written to `repos/{slug}/{filePath}`

### 2. File Content Endpoint (Collab Server)

**File:** `backend/collab-server/server.js`

New HTTP endpoint for fetching file content:

```
GET /file-content/:slug/:filePath
```

This endpoint reads directly from disk - the Source of Truth.

### 3. Container Analysis Endpoint (AI Backend)

**File:** `ai-backend/ai-engine/main.py`

New endpoint that fetches content from collab server:

```python
@app.post("/analyze/container")
async def analyze_from_container(req: ContainerAnalysisRequest):
    # Fetch from collab server - NOT from client!
    content = await fetch_file_from_container(req.slug, req.file_path)
    
    # Analyze the server-fetched content
    result = await analyzer.analyze(analysis_request)
    return result
```

### 4. Frontend Integration

**File:** `synthi/src/app/workspace/[slug]/page.jsx`

Analysis now uses path-based requests:

```javascript
// OLD (content-based - prone to stale content)
analyzeProactive({
    code: contentToAnalyze,  // Content from Redux/editor
    lang: normalizedLang,
    filePath: currentFilePath,
});

// NEW (Container-First - always fresh)
analyzeContainer({
    slug,                    // Workspace ID
    filePath: currentFilePath,
    lang: normalizedLang,
    relatedPaths,           // Just paths, not content!
});
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER TYPES                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MONACO EDITOR                               │
│                   (Visual feedback)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Y.js TEXT TYPE                               │
│                 (Real-time sync)                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                AUTO-FLUSH OBSERVER                              │
│           (Debounced 150ms writes)                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              SERVER FILESYSTEM (Source of Truth)                │
│                    repos/{slug}/{path}                          │
└─────────────────────────────────────────────────────────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ COMPILER │        │ AI/LINT  │        │   GIT    │
   │  (wasm)  │        │ (Python) │        │          │
   └──────────┘        └──────────┘        └──────────┘
```

## Timing Considerations

1. **User types** → Y.js updates immediately
2. **Auto-flush observer** fires
3. **150ms debounce** → Disk write
4. **Frontend debounce (500ms)** → Analysis request
5. **AI backend** fetches from collab server
6. **Analysis runs** on fresh content
7. **Results returned** → Diagnostics displayed

The 500ms frontend debounce (> 150ms server flush) ensures disk content is always fresh when analysis runs.

## Configuration

### Environment Variables

```bash
# AI Backend
COLLAB_SERVER_URL=http://localhost:1234  # URL to collab server

# Collab Server
COLLAB_PORT=1234  # HTTP/WebSocket port
```

## Key Files Modified

| File | Changes |
|------|---------|
| `backend/collab-server/server.js` | Added auto-flush mechanism, `/file-content` endpoint |
| `ai-backend/ai-engine/main.py` | Added `ContainerAnalysisRequest`, `fetch_file_from_container()`, `/analyze/container` endpoint |
| `ai-backend/gateway/server.js` | Added `analyze/container` route forwarding |
| `synthi/src/services/analyzerGatewayClient.js` | Added `analyzeContainer()` method |
| `synthi/src/hooks/useAnalyzerGateway.js` | Added `analyzeContainer` hook function |
| `synthi/src/app/workspace/[slug]/page.jsx` | Changed to use Container-First analysis |

## Benefits

1. **No more ghost errors** - Analysis always uses fresh content from disk
2. **Single Source of Truth** - Compiler, AI, Git all read from same place
3. **Automatic sync** - Y.js changes auto-flush to disk
4. **Simpler client** - Client sends paths, not content
5. **Better caching** - Server can cache based on file hash

## Troubleshooting

### Content not syncing?

Check auto-flush logs:
```
[Collab AutoFlush] main.cpp -> disk (1234 chars)
```

### Analysis returning 404?

File may not be flushed yet. Check timing:
- Increase frontend debounce (currently 500ms)
- Check collab server logs for flush events

### Verifying disk content

Use the debug endpoint:
```
GET /debug/validate/:slug/:filePath
```

This shows both disk content and cached hash for comparison.
