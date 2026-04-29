function isAdmin(role) {
  // bug: == coerces; "admin" == something_truthy_truthy may surprise
  return role == "admin";
}

module.exports = { isAdmin };
