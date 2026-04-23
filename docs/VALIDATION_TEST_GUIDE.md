# Quick Test Guide: AI Output Quality Validation

## What Was Added

Three validation layers that catch and reject bad AI output:

1. **Server-side validator** - detects duplicates, mixing, unclosed fences mid-stream
2. **Client-side validator** - detects content/extension mismatches after parsing  
3. **Enhanced prompt** - explicit format rules + examples so model generates better output

## How to Test

### Test 1: Normal Good Output (Should Work)
```
User Prompt: "improve the ui in my App.js file and fix any bugs"

Expected: 
- Single FILE: App.js block
- Valid JavaScript content
- All code fences closed
✓ Should apply suggestion normally
```

### Test 2: Duplicate File Detection (Should Reject)
If model tries to return:
```
FILE: src/App.js
```javascript
content1
```
FILE: src/App.js
```javascript
content2
```
```

**Expected Result**: 
- Red warning banner: "AI response was malformed: Duplicate FILE block for src/App.js"
- Suggestion NOT applied
- User asked to try again

### Test 3: HTML/JS Mixing (Should Reject)
If model returns JavaScript file with HTML:
```
FILE: src/utils/helper.js
```html
<!DOCTYPE html>
<body>...</body>
```
```

**Expected Result**:
- Warning: "Detected HTML in JS file - likely wrong file or content corruption"
- Suggestion rejected

### Test 4: Unclosed Code Fence (Should Reject)  
If model returns:
```
FILE: src/App.js
```javascript
const x = 1;
(missing closing ```)
```

**Expected Result**:
- Warning: "Unclosed code fence"
- Suggestion rejected

---

## Where to Monitor

### 1. **Browser Console** (Dev Tools - F12)
Look for logs like:
```
[Validation] Multi-file suggestions failed validation: [error message]
[Validated Stream] Validation error detected: ...
```

### 2. **UI Error Message**
If validation fails, you'll see a red banner in the chat:
```
⚠️ AI response was malformed or contained contradictory changes:
Duplicate FILE block for src/App.js - model repeated the same file

Please try again or provide more specific instructions.
```

### 3. **Network Tab** (Dev Tools - Network)
Check the `/api/chat` response headers:
- `x-validation-status: failed` (if validation caught error)
- Response body will include error details

---

## Step-by-Step Test

### Setup
1. Open `/synthi` in browser
2. Open Dev Tools (F12)
3. Go to Console tab
4. Open your workspace with a few files

### Run Test
1. **Click chat button**
2. **Type prompt**: "improve the ui and fix any inconsistent code"
3. **Wait for response**
4. **Watch console** for validation logs
5. **Check if**:
   - ✅ Suggestion appears with valid FILE blocks → Good
   - ❌ Warning banner appears → Validation caught error → Good!
   - ⚠️ Suggestion shows but looks broken → Old issue (should now be caught)

### Verify Validation Works
- Try again with prompt that's very specific: "only change the button color in App.js to blue"
- Should produce clean, single-file suggestion
- No validation errors should appear

---

## What Each Validator Catches

| Issue | Server Validator | Client Validator | Prompt Guidance |
|-------|------------------|------------------|-----------------|
| Duplicate files | ✅ YES | ✅ YES | ✅ YES |
| Empty content | ⚠️ Warning | ✅ YES | ✅ YES |
| HTML/JS mixing | ❌ NO | ✅ YES | ✅ YES |
| Unclosed fences | ✅ YES | ❌ NO | ✅ YES |
| Multiple DOCTYPE | ✅ YES | ❌ NO | ✅ YES |
| Wrong file format | ❌ NO | ✅ YES | ✅ YES |

---

## Expected Improvements

### Before This Fix:
- ❌ AI generates duplicate files → applies broken changes
- ❌ AI mixes HTML/JS → crashes editor
- ❌ Validation errors only caught by user (too late)

### After This Fix:  
- ✅ Validation catches errors BEFORE display
- ✅ User sees clear error message
- ✅ Can prompt again without damage
- ✅ Model gets explicit format guidance = fewer errors

---

## Troubleshooting

### Validation Always Fails
- Check browser console for specific error message
- Try different prompt (current one might be ambiguous)
- Check that `/api/chat` endpoint is working (network tab)

### Validation Never Triggers  
- Validation only triggers for CODE CHANGES (not explanations)
- Try a prompt with explicit change request: "add a button"
- Check Dev Tools console for any startup errors

### Suggestion Still Looks Broken
- Even after validation passes, content might be wrong (semantic issue)
- That's a model quality issue, not format issue
- Try rephrasing prompt more specifically
- Check code-intel context is being retrieved (network tab headers)

---

## Resetting/Disabling (If Needed)

### To Disable Server-Side Validation (Not Recommended):
In `/route.js`, change:
```javascript
return createGeminiReadableStream(upstream);
```
To:
```javascript
// Direct stream without validation wrapper
return upstream;
```

### To Disable Client-Side Validation (Not Recommended):
In `/useAISuggestions.js`, remove validation block:
```javascript
// DELETE THIS:
const validation = validateFileDiffBlocks(...);
if (!validation.isValid) { ... }
```

### To Use Old Prompt:
Replace `CODE_INTEL_SYSTEM_PROMPT` in `/route.js` with old version (check git history)

---

## Questions?

- Validation errors appear in console with context
- Check the validation error message for specific failure reason
- Error message tells you exactly what rule was violated
- Prompts explicitly show what's correct vs wrong in system prompt

The system is designed to **fail safely** — if unsure, it rejects rather than applies bad code.
