import threading
from counter import Counter


def test_threaded_increments():
    c = Counter()
    workers = []
    for _ in range(20):
        t = threading.Thread(target=lambda: [c.increment() for _ in range(50)])
        workers.append(t)
        t.start()
    for t in workers:
        t.join()
    assert c.value == 1000
