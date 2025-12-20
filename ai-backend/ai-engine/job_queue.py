"""
Priority Job Queue for AI Engine
================================
Implements a multi-lane job queue with priority handling for different request types.
Provides horizontal scaling support with stateless API and shared cache.

FAIRNESS:
- Queue aging prevents starvation of lower priority tiers
- Jobs age up in priority after configurable wait time
- Maximum age caps prevent indefinite promotion
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable, Dict, List, Optional, TypeVar

from pydantic import BaseModel


# =============================================================================
# QUEUE AGING CONFIGURATION
# =============================================================================
# Prevents starvation by promoting jobs that have waited too long

AGE_PROMOTION_INTERVAL_SECONDS = 30.0  # Check for aging every N seconds
AGE_THRESHOLD_SECONDS = 60.0           # Promote after waiting this long
MAX_PROMOTIONS = 2                      # Max priority levels a job can be promoted
STARVATION_ALERT_THRESHOLD = 300.0     # Alert if job waits longer than this


class JobPriority(IntEnum):
    """Job priority levels. Lower number = higher priority."""
    CRITICAL = 0      # Emergency repairs, crash recovery
    HIGH = 1          # Interactive AI analysis (user waiting)
    NORMAL = 2        # Standard AI refactoring
    LOW = 3           # Background static analysis
    BULK = 4          # Batch processing, non-interactive


class JobType(IntEnum):
    """Job type lanes for separate queue management."""
    STATIC = 0        # Static analysis (fast, deterministic)
    AI_ANALYZE = 1    # AI code analysis
    AI_REFACTOR = 2   # AI refactoring/split operations
    AI_GENERATE = 3   # AI code generation


@dataclass
class JobBudget:
    """Per-request resource budget."""
    max_time_seconds: float = 30.0
    max_tokens: int = 4096
    max_retries: int = 2
    allow_streaming: bool = True
    
    def copy(self) -> "JobBudget":
        return JobBudget(
            max_time_seconds=self.max_time_seconds,
            max_tokens=self.max_tokens,
            max_retries=self.max_retries,
            allow_streaming=self.allow_streaming,
        )


# Default budgets per job type
DEFAULT_BUDGETS: Dict[JobType, JobBudget] = {
    JobType.STATIC: JobBudget(max_time_seconds=5.0, max_tokens=0, max_retries=1),
    JobType.AI_ANALYZE: JobBudget(max_time_seconds=30.0, max_tokens=4096, max_retries=2),
    JobType.AI_REFACTOR: JobBudget(max_time_seconds=60.0, max_tokens=8192, max_retries=2),
    JobType.AI_GENERATE: JobBudget(max_time_seconds=120.0, max_tokens=16384, max_retries=3),
}


@dataclass(order=True)
class Job:
    """A job in the priority queue."""
    # Ordering fields (used by heapq)
    priority: int = field(compare=True)
    created_at: float = field(compare=True)
    
    # Non-ordering fields
    job_id: str = field(compare=False, default_factory=lambda: str(uuid.uuid4()))
    job_type: JobType = field(compare=False, default=JobType.AI_ANALYZE)
    payload: Dict[str, Any] = field(compare=False, default_factory=dict)
    budget: JobBudget = field(compare=False, default_factory=JobBudget)
    
    # Execution tracking
    started_at: Optional[float] = field(compare=False, default=None)
    completed_at: Optional[float] = field(compare=False, default=None)
    retries: int = field(compare=False, default=0)
    result: Optional[Any] = field(compare=False, default=None)
    error: Optional[str] = field(compare=False, default=None)
    
    # Provenance tracking
    request_hash: Optional[str] = field(compare=False, default=None)
    model_used: Optional[str] = field(compare=False, default=None)
    tokens_used: int = field(compare=False, default=0)
    
    # Cancellation support
    cancelled: bool = field(compare=False, default=False)
    cancel_event: asyncio.Event = field(compare=False, default_factory=asyncio.Event)
    
    # AGING SUPPORT - Prevents starvation
    original_priority: int = field(compare=False, default=-1)  # -1 means not set
    promotions: int = field(compare=False, default=0)          # Times promoted
    last_promotion_at: Optional[float] = field(compare=False, default=None)
    
    def __post_init__(self):
        if self.original_priority == -1:
            self.original_priority = self.priority
    
    @property
    def wait_time_seconds(self) -> float:
        """Time since job was created."""
        return time.time() - self.created_at
    
    @property
    def can_promote(self) -> bool:
        """Check if job can be promoted."""
        return self.promotions < MAX_PROMOTIONS and self.priority > JobPriority.CRITICAL.value
    
    def promote(self) -> bool:
        """Promote job to higher priority. Returns True if promoted."""
        if not self.can_promote:
            return False
        self.priority -= 1
        self.promotions += 1
        self.last_promotion_at = time.time()
        return True


class JobQueueStats(BaseModel):
    """Statistics for job queue monitoring."""
    total_jobs: int = 0
    pending_jobs: int = 0
    running_jobs: int = 0
    completed_jobs: int = 0
    failed_jobs: int = 0
    cancelled_jobs: int = 0
    avg_wait_time_ms: float = 0.0
    avg_processing_time_ms: float = 0.0
    jobs_by_type: Dict[str, int] = {}
    jobs_by_priority: Dict[str, int] = {}
    # AGING STATS
    total_promotions: int = 0
    starvation_alerts: int = 0
    max_wait_time_ms: float = 0.0
    jobs_promoted: int = 0


class PriorityJobQueue:
    """
    Multi-lane priority job queue with resource budgeting.
    
    Features:
    - Priority-based scheduling (0 = highest)
    - Separate lanes for different job types
    - Per-request time and token budgets
    - Cancellation support
    - Statistics tracking
    - Horizontal scaling ready (stateless)
    - QUEUE AGING to prevent starvation
    """
    
    def __init__(
        self,
        max_concurrent_per_type: Optional[Dict[JobType, int]] = None,
        global_max_concurrent: int = 10,
        enable_aging: bool = True,  # Enable starvation prevention
        age_threshold_seconds: float = AGE_THRESHOLD_SECONDS,
        age_check_interval: float = AGE_PROMOTION_INTERVAL_SECONDS,
    ):
        # Separate queues per job type (lane)
        self._queues: Dict[JobType, asyncio.PriorityQueue] = {
            jt: asyncio.PriorityQueue() for jt in JobType
        }
        
        # Semaphores for concurrency control per lane
        default_limits = {
            JobType.STATIC: 20,      # Static analysis is fast
            JobType.AI_ANALYZE: 5,   # AI analysis is expensive
            JobType.AI_REFACTOR: 3,  # Refactor is most expensive
            JobType.AI_GENERATE: 2,  # Generation is very expensive
        }
        limits = max_concurrent_per_type or default_limits
        self._semaphores: Dict[JobType, asyncio.Semaphore] = {
            jt: asyncio.Semaphore(limits.get(jt, 5)) for jt in JobType
        }
        
        # Global semaphore to prevent overwhelming the system
        self._global_semaphore = asyncio.Semaphore(global_max_concurrent)
        
        # Tracking
        self._jobs: Dict[str, Job] = {}
        self._running: Dict[str, Job] = {}
        self._completed: List[Job] = []
        self._stats = JobQueueStats()
        
        # AGING CONFIGURATION
        self._enable_aging = enable_aging
        self._age_threshold = age_threshold_seconds
        self._age_check_interval = age_check_interval
        self._aging_task: Optional[asyncio.Task] = None
        
        # Lock for thread-safe operations
        self._lock = asyncio.Lock()
        
        # Shutdown flag
        self._shutdown = False
    
    async def start_aging(self) -> None:
        """Start the aging task to prevent starvation."""
        if self._enable_aging and self._aging_task is None:
            self._aging_task = asyncio.create_task(self._aging_loop())
    
    async def stop_aging(self) -> None:
        """Stop the aging task."""
        if self._aging_task:
            self._aging_task.cancel()
            try:
                await self._aging_task
            except asyncio.CancelledError:
                pass
            self._aging_task = None
    
    async def _aging_loop(self) -> None:
        """Background task that promotes starving jobs."""
        while not self._shutdown:
            await asyncio.sleep(self._age_check_interval)
            await self._promote_starving_jobs()
    
    async def _promote_starving_jobs(self) -> None:
        """Check for and promote jobs that have waited too long."""
        now = time.time()
        promoted_count = 0
        
        async with self._lock:
            for job in self._jobs.values():
                # Skip jobs that are running, completed, or cancelled
                if job.started_at is not None or job.cancelled:
                    continue
                
                wait_time = now - job.created_at
                
                # Update max wait time stat
                wait_ms = wait_time * 1000
                if wait_ms > self._stats.max_wait_time_ms:
                    self._stats.max_wait_time_ms = wait_ms
                
                # Check for starvation alert
                if wait_time > STARVATION_ALERT_THRESHOLD:
                    self._stats.starvation_alerts += 1
                
                # Check if job should be promoted
                time_since_last = wait_time
                if job.last_promotion_at:
                    time_since_last = now - job.last_promotion_at
                
                if time_since_last >= self._age_threshold and job.can_promote:
                    old_priority = job.priority
                    if job.promote():
                        promoted_count += 1
                        self._stats.total_promotions += 1
                        # Log promotion for debugging
                        print(f"[AGING] Job {job.job_id[:8]} promoted: "
                              f"priority {old_priority} -> {job.priority} "
                              f"(waited {wait_time:.1f}s)")
        
        if promoted_count > 0:
            self._stats.jobs_promoted += promoted_count
    
    async def submit(
        self,
        job_type: JobType,
        payload: Dict[str, Any],
        priority: JobPriority = JobPriority.NORMAL,
        budget: Optional[JobBudget] = None,
    ) -> str:
        """Submit a job to the queue. Returns job_id."""
        if self._shutdown:
            raise RuntimeError("Queue is shutting down")
        
        # Create request hash for caching/deduplication
        request_hash = hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode()
        ).hexdigest()[:16]
        
        job = Job(
            priority=priority.value,
            created_at=time.time(),
            job_type=job_type,
            payload=payload,
            budget=budget or DEFAULT_BUDGETS.get(job_type, JobBudget()).copy(),
            request_hash=request_hash,
        )
        
        async with self._lock:
            self._jobs[job.job_id] = job
            self._stats.total_jobs += 1
            self._stats.pending_jobs += 1
            
            # Update type stats
            type_name = job_type.name
            self._stats.jobs_by_type[type_name] = \
                self._stats.jobs_by_type.get(type_name, 0) + 1
        
        # Add to appropriate queue
        await self._queues[job_type].put(job)
        
        return job.job_id
    
    async def cancel(self, job_id: str) -> bool:
        """Cancel a job by ID. Returns True if cancelled."""
        async with self._lock:
            if job_id in self._jobs:
                job = self._jobs[job_id]
                job.cancelled = True
                job.cancel_event.set()
                self._stats.cancelled_jobs += 1
                if job_id not in self._running:
                    self._stats.pending_jobs -= 1
                return True
        return False
    
    async def get_next(self, job_type: JobType) -> Optional[Job]:
        """Get the next job for a given type. Returns None if queue empty."""
        try:
            # Non-blocking check
            job = self._queues[job_type].get_nowait()
            
            async with self._lock:
                if job.cancelled:
                    self._stats.pending_jobs -= 1
                    return None
                
                job.started_at = time.time()
                self._running[job.job_id] = job
                self._stats.pending_jobs -= 1
                self._stats.running_jobs += 1
            
            return job
        except asyncio.QueueEmpty:
            return None
    
    async def complete(
        self,
        job_id: str,
        result: Optional[Any] = None,
        error: Optional[str] = None,
        tokens_used: int = 0,
        model_used: Optional[str] = None,
    ) -> None:
        """Mark a job as complete."""
        async with self._lock:
            if job_id in self._running:
                job = self._running.pop(job_id)
                job.completed_at = time.time()
                job.result = result
                job.error = error
                job.tokens_used = tokens_used
                job.model_used = model_used
                
                self._stats.running_jobs -= 1
                if error:
                    self._stats.failed_jobs += 1
                else:
                    self._stats.completed_jobs += 1
                
                # Update average times
                wait_time = (job.started_at - job.created_at) * 1000
                proc_time = (job.completed_at - job.started_at) * 1000
                
                # Rolling average
                n = self._stats.completed_jobs + self._stats.failed_jobs
                self._stats.avg_wait_time_ms = (
                    (self._stats.avg_wait_time_ms * (n - 1) + wait_time) / n
                )
                self._stats.avg_processing_time_ms = (
                    (self._stats.avg_processing_time_ms * (n - 1) + proc_time) / n
                )
                
                # Keep last N completed jobs for debugging
                self._completed.append(job)
                if len(self._completed) > 1000:
                    self._completed.pop(0)
    
    async def get_job(self, job_id: str) -> Optional[Job]:
        """Get a job by ID."""
        async with self._lock:
            return self._jobs.get(job_id) or self._running.get(job_id)
    
    async def get_stats(self) -> JobQueueStats:
        """Get current queue statistics."""
        async with self._lock:
            return self._stats.model_copy()
    
    async def shutdown(self, timeout: float = 30.0) -> None:
        """Gracefully shutdown the queue."""
        self._shutdown = True
        
        # Stop aging task
        await self.stop_aging()
        
        # Wait for running jobs to complete
        start = time.time()
        while self._running and (time.time() - start) < timeout:
            await asyncio.sleep(0.1)
        
        # Cancel remaining jobs
        for job_id in list(self._running.keys()):
            await self.cancel(job_id)
    
    async def get_aging_stats(self) -> Dict[str, Any]:
        """Get aging-specific statistics."""
        async with self._lock:
            pending_by_priority = {}
            starving_jobs = []
            now = time.time()
            
            for job in self._jobs.values():
                if job.started_at is None and not job.cancelled:
                    # Count by priority
                    p = str(job.priority)
                    pending_by_priority[p] = pending_by_priority.get(p, 0) + 1
                    
                    # Track starving jobs
                    wait_time = now - job.created_at
                    if wait_time > self._age_threshold:
                        starving_jobs.append({
                            "job_id": job.job_id[:8],
                            "original_priority": job.original_priority,
                            "current_priority": job.priority,
                            "promotions": job.promotions,
                            "wait_seconds": wait_time,
                        })
            
            return {
                "aging_enabled": self._enable_aging,
                "age_threshold_seconds": self._age_threshold,
                "pending_by_priority": pending_by_priority,
                "starving_jobs": starving_jobs,
                "total_promotions": self._stats.total_promotions,
                "starvation_alerts": self._stats.starvation_alerts,
            }


class JobWorker:
    """
    Worker that processes jobs from a queue.
    Designed for horizontal scaling - each worker is stateless.
    """
    
    def __init__(
        self,
        queue: PriorityJobQueue,
        job_type: JobType,
        handler: Callable,
        worker_id: Optional[str] = None,
    ):
        self.queue = queue
        self.job_type = job_type
        self.handler = handler
        self.worker_id = worker_id or str(uuid.uuid4())[:8]
        self._running = False
        self._task: Optional[asyncio.Task] = None
    
    async def start(self) -> None:
        """Start the worker."""
        self._running = True
        self._task = asyncio.create_task(self._run())
    
    async def stop(self) -> None:
        """Stop the worker."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
    
    async def _run(self) -> None:
        """Main worker loop."""
        while self._running:
            # Acquire semaphores
            async with self.queue._global_semaphore:
                async with self.queue._semaphores[self.job_type]:
                    job = await self.queue.get_next(self.job_type)
                    
                    if job is None:
                        # No job available, wait a bit
                        await asyncio.sleep(0.1)
                        continue
                    
                    # Process job with budget enforcement
                    await self._process_job(job)
    
    async def _process_job(self, job: Job) -> None:
        """Process a single job with budget enforcement."""
        result = None
        error = None
        tokens_used = 0
        model_used = None
        
        try:
            # Create timeout based on budget
            async with asyncio.timeout(job.budget.max_time_seconds):
                # Check for cancellation
                if job.cancelled:
                    return
                
                # Execute handler
                result = await self.handler(
                    job.payload,
                    budget=job.budget,
                    cancel_event=job.cancel_event,
                )
                
                # Extract metadata if handler returns it
                if isinstance(result, dict):
                    tokens_used = result.get("tokens_used", 0)
                    model_used = result.get("model_used")
                    result = result.get("result", result)
        
        except asyncio.TimeoutError:
            error = f"Job timed out after {job.budget.max_time_seconds}s"
            
            # Retry if allowed
            if job.retries < job.budget.max_retries:
                job.retries += 1
                await self.queue._queues[job.job_type].put(job)
                return
        
        except asyncio.CancelledError:
            error = "Job was cancelled"
        
        except Exception as e:
            error = f"{type(e).__name__}: {str(e)}"
            
            # Retry if allowed
            if job.retries < job.budget.max_retries:
                job.retries += 1
                await self.queue._queues[job.job_type].put(job)
                return
        
        # Mark complete
        await self.queue.complete(
            job.job_id,
            result=result,
            error=error,
            tokens_used=tokens_used,
            model_used=model_used,
        )


# Shared cache interface for horizontal scaling
class SharedCache:
    """
    Interface for shared cache across worker instances.
    Implementations can use Redis, Memcached, or other distributed caches.
    """
    
    async def get(self, key: str) -> Optional[Any]:
        raise NotImplementedError
    
    async def set(self, key: str, value: Any, ttl_seconds: int = 3600) -> None:
        raise NotImplementedError
    
    async def delete(self, key: str) -> None:
        raise NotImplementedError


class InMemoryCache(SharedCache):
    """In-memory cache for single-instance deployment."""
    
    def __init__(self, max_size: int = 1000):
        self._cache: Dict[str, tuple] = {}  # key -> (value, expires_at)
        self._max_size = max_size
    
    async def get(self, key: str) -> Optional[Any]:
        if key in self._cache:
            value, expires_at = self._cache[key]
            if expires_at > time.time():
                return value
            else:
                del self._cache[key]
        return None
    
    async def set(self, key: str, value: Any, ttl_seconds: int = 3600) -> None:
        # Evict oldest if at capacity
        if len(self._cache) >= self._max_size:
            oldest_key = min(self._cache.keys(), key=lambda k: self._cache[k][1])
            del self._cache[oldest_key]
        
        self._cache[key] = (value, time.time() + ttl_seconds)
    
    async def delete(self, key: str) -> None:
        self._cache.pop(key, None)


# Global queue instance (for single-process deployment)
_global_queue: Optional[PriorityJobQueue] = None


def get_queue() -> PriorityJobQueue:
    """Get or create the global job queue."""
    global _global_queue
    if _global_queue is None:
        _global_queue = PriorityJobQueue()
    return _global_queue
