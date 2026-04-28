package users

import "testing"

func TestFindHit(t *testing.T) {
	users := []*User{{1, "alice"}, {2, "bob"}}
	name, ok := Find(users, 2)
	if !ok || name != "bob" {
		t.Fatalf("expected (bob,true), got (%q,%v)", name, ok)
	}
}

func TestFindMissReturnsEmpty(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Find panicked on miss: %v", r)
		}
	}()
	users := []*User{{1, "alice"}}
	name, ok := Find(users, 99)
	if ok || name != "" {
		t.Fatalf("expected (empty,false), got (%q,%v)", name, ok)
	}
}
