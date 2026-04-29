// Refactor target: convert the promise-chain implementation to async/await
// without changing observable behaviour.

const { fetchUser, fetchOrgs } = require('./api');

function loadProfile(userId) {
    return fetchUser(userId)
        .then((user) => {
            return fetchOrgs(user.id).then((orgs) => {
                return { user, orgs };
            });
        })
        .catch((err) => {
            return { user: null, orgs: [], error: err.message };
        });
}

module.exports = { loadProfile };
