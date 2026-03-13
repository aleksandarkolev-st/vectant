import os

target = r"src/app/workspace/StatusBar.jsx"

with open(target, 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Remove cursor selectors from StatusBarInner
import re
text = re.sub(
    r"\s*const positionRaw = useSelector\(selectCursorPosition\);\s*const position = useDeferredValue\(positionRaw\);",
    "",
    text
)

# 2. Extract into its own component
new_comp = """
const StatusBarCursorInfo = memo(function StatusBarCursorInfo() {
  const positionRaw = useSelector(selectCursorPosition);
  const position = useDeferredValue(positionRaw);
  return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors">
      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Ln {position.lineNumber}</span>
      <span style={{ color: 'var(--text-dim)' }}>:</span>
      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Col {position.column}</span>
    </div>
  );
});

function StatusBarInner"""

text = text.replace("function StatusBarInner", new_comp)

# 3. Replace usage
old_usage = """        <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors">
          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Ln {position.lineNumber}</span>
          <span style={{ color: 'var(--text-dim)' }}>:</span>
          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Col {position.column}</span>
        </div>"""

new_usage = """        <StatusBarCursorInfo />"""

text = text.replace(old_usage, new_usage)

with open(target, 'w', encoding='utf-8') as f:
    f.write(text)

print("Done StatusBar modification!")