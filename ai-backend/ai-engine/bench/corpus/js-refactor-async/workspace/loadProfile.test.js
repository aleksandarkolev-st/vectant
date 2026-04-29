const { loadProfile } = require('./loadProfile');

test('returns user + orgs on success', async () => {
    const result = await loadProfile('123');
    expect(result.user).toEqual({ id: '123', name: 'user-123' });
    expect(result.orgs).toEqual([{ id: 'org-1', userId: '123' }]);
    expect(result.error).toBeUndefined();
});

test('captures fetchUser failure', async () => {
    const result = await loadProfile('fail');
    expect(result.user).toBeNull();
    expect(result.orgs).toEqual([]);
    expect(result.error).toBe('user lookup failed');
});
