class Counter:
    def __init__(self):
        self.value = 0

    def increment(self, n=1):
        # bug: read-modify-write across threads loses updates
        new = self.value + n
        # simulate work between read and write
        for _ in range(50):
            pass
        self.value = new
