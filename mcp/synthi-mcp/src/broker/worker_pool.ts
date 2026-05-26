export interface BrokerWorkerPoolStats {
  max_concurrency: number;
  max_queue: number;
  active: number;
  queued: number;
  completed: number;
  rejected: number;
  max_observed_active: number;
}

interface QueuedTask<T> {
  label: string;
  run: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export const DEFAULT_BROKER_WORKER_POOL_SIZE = 2;
export const DEFAULT_BROKER_WORKER_QUEUE_SIZE = 64;

export function resolveBrokerWorkerPoolSize(raw: string | undefined = process.env["SYNTHI_BROKER_WORKER_POOL_SIZE"]): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BROKER_WORKER_POOL_SIZE;
  return Math.min(16, parsed);
}

export function resolveBrokerWorkerQueueSize(raw: string | undefined = process.env["SYNTHI_BROKER_WORKER_QUEUE_SIZE"]): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BROKER_WORKER_QUEUE_SIZE;
  return Math.min(10_000, parsed);
}

export class BrokerWorkerPool {
  private readonly queue: QueuedTask<unknown>[] = [];
  private active = 0;
  private completed = 0;
  private rejected = 0;
  private maxObservedActive = 0;

  constructor(
    private readonly maxConcurrency: number = resolveBrokerWorkerPoolSize(),
    private readonly maxQueue: number = resolveBrokerWorkerQueueSize()
  ) {}

  run<T>(label: string, task: () => Promise<T> | T): Promise<T> {
    if (this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      return Promise.reject(new Error(`BROKER_WORKER_QUEUE_FULL (${label})`));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, run: task, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  stats(): BrokerWorkerPoolStats {
    return {
      max_concurrency: this.maxConcurrency,
      max_queue: this.maxQueue,
      active: this.active,
      queued: this.queue.length,
      completed: this.completed,
      rejected: this.rejected,
      max_observed_active: this.maxObservedActive,
    };
  }

  _resetForTests(): void {
    this.queue.length = 0;
    this.active = 0;
    this.completed = 0;
    this.rejected = 0;
    this.maxObservedActive = 0;
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active);
      void this.execute(task);
    }
  }

  private async execute<T>(task: QueuedTask<T>): Promise<void> {
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const value = await task.run();
      this.completed += 1;
      task.resolve(value);
    } catch (err) {
      task.reject(err);
    } finally {
      this.active -= 1;
      this.pump();
    }
  }
}

export const brokerVisualWorkerPool = new BrokerWorkerPool();
