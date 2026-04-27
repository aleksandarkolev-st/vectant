const { parseAge } = require('./parseAge');

test('parses a numeric string', () => {
    expect(parseAge('42')).toBe(42);
});

test('returns null for null input', () => {
    expect(parseAge(null)).toBeNull();
});

test('returns null for undefined input', () => {
    expect(parseAge(undefined)).toBeNull();
});

test('trims whitespace', () => {
    expect(parseAge('  17  ')).toBe(17);
});
