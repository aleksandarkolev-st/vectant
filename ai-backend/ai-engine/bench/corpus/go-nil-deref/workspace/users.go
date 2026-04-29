package users

type User struct {
	ID   int
	Name string
}

// Find returns (name, found). The current implementation panics
// with a nil-pointer dereference when no user matches.
func Find(users []*User, id int) (string, bool) {
	var found *User
	for _, u := range users {
		if u.ID == id {
			found = u
			break
		}
	}
	return found.Name, found != nil
}
