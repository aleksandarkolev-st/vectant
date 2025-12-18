# Proactive Code Analysis System

## Overview

The Proactive Code Analysis system is a sophisticated multi-tier analysis pipeline that detects potential errors in your code **before compilation**. It provides real-time feedback as you type, helping you catch bugs early and write better code.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Frontend (Next.js)                              │
├─────────────────────────────────────────────────────────────────────────┤
│  ProactiveAnalysisProvider ──► useProactiveAnalysis Hook                │
│         │                              │                                 │
│         ▼                              ▼                                 │
│  ProblemsPanel             Monaco Editor Integration                     │
│  (Inline warnings,         (Squiggly underlines, hover tooltips)        │
│   Problems Panel)                                                        │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ WebSocket (debounced, diff-based)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Gateway (Node.js)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  analyze/proactive        - Full analysis (all tiers)                   │
│  analyze/proactive/quick  - Quick analysis (static + semantic)          │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ HTTP/REST
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     AI Engine (Python FastAPI)                           │
├─────────────────────────────────────────────────────────────────────────┤
│  ProactiveAnalyzer                                                       │
│    ├── StaticAnalyzer   - Fast pattern-based (< 100ms)                  │
│    ├── SemanticAnalyzer - Deep AST analysis (< 500ms)                   │
│    ├── AIErrorPredictor - LLM-powered (< 3s)                            │
│    └── AnalysisCache    - Content-hash based caching                    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Analysis Tiers

### 1. Static Analysis (< 100ms)
Fast pattern-based detection using regex and simple heuristics:
- Syntax errors
- Common anti-patterns (== instead of ===)
- Debug statements (console.log, print)
- TODO/FIXME comments
- Style violations

### 2. Semantic Analysis (< 500ms)
Deep AST-based analysis providing:
- **Variable scope analysis**: Undefined and unused variables
- **Type inference**: Potential type mismatches
- **Control flow analysis**: Unreachable code, missing returns
- **Resource lifecycle**: Unclosed handles, memory leaks
- **Function signatures**: Argument mismatches

### 3. AI Analysis (< 3s)
LLM-powered deep analysis for subtle issues:
- **Logic errors**: Off-by-one, incorrect conditions
- **Security issues**: SQL injection, XSS, hardcoded secrets
- **Race conditions**: Data races, deadlocks
- **API misuse**: Incorrect function usage
- **Edge cases**: Null handling, boundary conditions

## Supported Languages

| Language | Static | Semantic | AI |
|----------|--------|----------|-----|
| Python | ✅ | ✅ | ✅ |
| TypeScript/JavaScript | ✅ | ✅ | ✅ |
| C/C++ | ✅ | ✅ | ✅ |
| Rust | ✅ | 🔄 | ✅ |
| Go | ✅ | 🔄 | ✅ |
| Java | ✅ | 🔄 | ✅ |

✅ = Full support, 🔄 = Partial/In progress

## Usage

### Frontend Integration

```jsx
import {
  ProactiveAnalysisProvider,
  ProblemsPanel,
  ProactiveAnalysisStatusBadge,
  useProactiveAnalysisContext,
} from '@/components/analysis';

// Wrap your app with the provider
function App() {
  return (
    <ProactiveAnalysisProvider>
      <YourEditor />
      <ProblemsPanel />
    </ProactiveAnalysisProvider>
  );
}

// In your editor component
function YourEditor() {
  const {
    registerEditor,
    diagnostics,
    isAnalyzing,
    triggerAnalysis,
  } = useProactiveAnalysisContext();
  
  useEffect(() => {
    if (editor && monaco) {
      const cleanup = registerEditor(editor, monaco, fileUri);
      return cleanup;
    }
  }, [editor, monaco, fileUri]);
  
  return <MonacoEditor />;
}
```

### Using the Hook Directly

```jsx
import { useProactiveAnalysis } from '@/hooks/useProactiveAnalysis';

function MyComponent() {
  const {
    diagnostics,
    summary,
    isAnalyzing,
    triggerAnalysis,
    analyzeFull,
  } = useProactiveAnalysis({
    debounceMs: 500,
    includeAi: false,
  });
  
  // Trigger analysis on content change
  const handleContentChange = (content) => {
    triggerAnalysis({
      code: content,
      lang: 'python',
      filePath: 'main.py',
    });
  };
  
  return (
    <div>
      {summary.errors > 0 && (
        <span>Found {summary.errors} errors</span>
      )}
    </div>
  );
}
```

### API Endpoints

#### POST `/analyze/proactive`
Full proactive analysis with all tiers.

```json
{
  "code": "def foo():\n  print(x)\n",
  "lang": "python",
  "file_path": "main.py",
  "tiers": ["static", "semantic", "ai"],
  "include_ai": true,
  "max_diagnostics": 50,
  "related_files": [
    { "path": "utils.py", "content": "..." }
  ]
}
```

Response:
```json
{
  "filePath": "main.py",
  "contentHash": "abc123...",
  "language": "python",
  "diagnostics": [
    {
      "message": "Name 'x' is not defined",
      "severity": "error",
      "tier": "semantic",
      "location": {
        "line": 1,
        "column": 8,
        "endLine": 1,
        "endColumn": 9
      },
      "code": "SEM001",
      "category": "undefined_variable"
    }
  ],
  "summary": {
    "errors": 1,
    "warnings": 0,
    "total": 1
  },
  "tiers": {
    "static": { "elapsedMs": 12, "fromCache": false },
    "semantic": { "elapsedMs": 45, "fromCache": false }
  },
  "totalElapsedMs": 57
}
```

#### POST `/analyze/proactive/quick`
Quick analysis optimized for real-time feedback (static + semantic only).

```json
{
  "code": "...",
  "lang": "python",
  "file_path": "main.py"
}
```

#### GET `/analyze/proactive/cache/stats`
Get cache statistics.

```json
{
  "entries": 150,
  "hits": 1234,
  "misses": 567,
  "hitRate": 0.685,
  "maxEntries": 2000
}
```

## Diagnostic Categories

| Category | Description |
|----------|-------------|
| `syntax` | Syntax errors |
| `type_error` | Type-related issues |
| `null_reference` | Potential null/undefined dereference |
| `undefined_variable` | Use of undefined variables |
| `unused_code` | Unused variables, imports, code |
| `security` | Security vulnerabilities |
| `performance` | Performance issues |
| `style` | Code style violations |
| `logic_error` | Logic bugs |
| `resource_leak` | Resource management issues |
| `concurrency` | Race conditions, deadlocks |
| `best_practice` | Best practice violations |

## Severity Levels

| Level | Description | Visual |
|-------|-------------|--------|
| `error` | Critical issues that will cause failures | 🔴 Red wavy underline |
| `warning` | Potential issues that should be addressed | 🟡 Yellow wavy underline |
| `info` | Informational suggestions | 🔵 Blue dashed underline |
| `hint` | Minor suggestions | 🟢 Green dotted underline |

## Configuration

### Frontend Settings

```javascript
const settings = {
  enabled: true,           // Enable/disable proactive analysis
  debounceMs: 500,         // Debounce delay for analysis
  includeAi: false,        // Include AI tier by default
  aiOnSave: true,          // Run AI analysis on save
  showInlineHints: true,   // Show inline decorations
  showGutterIcons: true,   // Show gutter icons
  maxDiagnostics: 100,     // Maximum diagnostics to display
  minSeverity: 'hint',     // Minimum severity to show
};
```

### Backend Settings

Environment variables:
```
PROACTIVE_ANALYSIS_CACHE_SIZE=2000
PROACTIVE_ANALYSIS_CACHE_TTL=3600
PROACTIVE_ANALYSIS_AI_MIN_CONFIDENCE=0.6
PROACTIVE_ANALYSIS_AI_TIMEOUT=30
```

## Performance

### Typical Response Times
- Static analysis: 10-50ms
- Semantic analysis: 30-200ms
- AI analysis: 1-3s

### Caching
- Content-hash based caching
- LRU eviction with configurable max entries
- 1-hour TTL by default
- Cache hit rates typically 60-80%

### Debouncing
- 500ms default debounce on keystroke
- Prevents overwhelming the backend
- Quick analysis runs on every debounced change
- AI analysis rate-limited to 5s intervals

## Files

### Backend (`ai-backend/ai-engine/analyzer/proactive/`)
- `__init__.py` - Module exports
- `types.py` - Type definitions (Diagnostic, Severity, etc.)
- `cache.py` - Content-hash based analysis cache
- `semantic_analyzer.py` - Deep AST analysis
- `ai_predictor.py` - LLM-powered error prediction
- `orchestrator.py` - Coordinates all analysis tiers

### Frontend (`synthi/src/`)
- `hooks/useProactiveAnalysis.js` - Main analysis hook
- `services/monacoDiagnosticsAdapter.js` - Monaco integration
- `services/analyzerGatewayClient.js` - WebSocket client
- `components/analysis/ProactiveAnalysisProvider.jsx` - Context provider
- `components/analysis/ProblemsPanel.jsx` - Problems panel UI
- `components/analysis/ProactiveAnalysisStatus.jsx` - Status indicators

### Gateway (`ai-backend/gateway/`)
- `server.js` - WebSocket server with proactive analysis handlers

## Extending the System

### Adding a New Language Analyzer

1. Create a new analyzer class in `semantic_analyzer.py`:

```python
class RustSemanticAnalyzer(BaseSemanticAnalyzer):
    language = "rust"
    
    def analyze(self, file: FileContext) -> List[Diagnostic]:
        diagnostics = []
        # Your analysis logic here
        return diagnostics
```

2. Register it in the `SemanticAnalyzer` class:

```python
def __init__(self):
    self._register(RustSemanticAnalyzer())
```

### Adding New Diagnostic Categories

1. Add to `DiagnosticCategory` enum in `types.py`:

```python
class DiagnosticCategory(str, Enum):
    MY_NEW_CATEGORY = "my_new_category"
```

2. Update AI prompt in `ai_predictor.py` to detect the new category.

### Custom Quick Fixes

Add fixes to diagnostics in the analyzer:

```python
diagnostic = Diagnostic(
    message="Variable 'x' is unused",
    # ... other fields
    fixes=[
        CodeFix(
            description="Remove unused variable",
            replacement_text="",
            location=DiagnosticLocation(...),
            is_preferred=True,
        ),
        CodeFix(
            description="Prefix with underscore",
            replacement_text="_x",
            location=DiagnosticLocation(...),
        ),
    ],
)
```

## Troubleshooting

### Analysis Not Running
1. Check WebSocket connection status
2. Verify gateway and AI engine are running
3. Check browser console for errors

### Slow Analysis
1. Enable caching if not already
2. Reduce max diagnostics limit
3. Disable AI tier for real-time analysis

### Missing Diagnostics
1. Check if language is supported
2. Verify file content is being sent
3. Check severity filter settings

## Future Enhancements

- [ ] Cross-file analysis (import tracking)
- [ ] Workspace-wide analysis
- [ ] Custom rule configuration
- [ ] Integration with CI/CD
- [ ] Machine learning-based pattern detection
- [ ] Fix application via code actions
