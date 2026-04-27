// Tiny mock of the network surface used by loadProfile.

async function fetchUser(id) {
    if (id === 'fail') throw new Error('user lookup failed');
    return { id, name: `user-${id}` };
}

async function fetchOrgs(userId) {
    return [{ id: 'org-1', userId }];
}

module.exports = { fetchUser, fetchOrgs };
