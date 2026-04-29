// Bug: parseAge does not handle null / undefined inputs and crashes.
// The fix is to return null when the input is falsy or not a string.

function parseAge(input) {
    return parseInt(input.trim(), 10);
}

module.exports = { parseAge };
