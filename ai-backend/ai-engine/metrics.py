"""
Comprehensive Metrics Collection for AI Engine
===============================================
Tracks all performance, reliability, and throughput metrics across the system.

Metric Categories:
- Latency: TTFT, full completion, queue delay
- Throughput: tokens/second, requests/second  
- Model path: inference time, prompt/output size distribution
- Retrieval: latency P50/P95/P99, Recall@k, MRR
- Reliability: error rate, timeout rate, cold start latency
- Load behavior: latency vs concurrency, P95 under peak load
"""

from __future__ import annotations

import time
import asyncio
import statistics
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Deque
from collections import deque
from threading import Lock
import logging

logger = logging.getLogger(__name__)


# =============================================================================
# Configuration
# =============================================================================

MAX_SAMPLES = 500  # Max samples to keep per metric for percentile calculation
SATURATION_WINDOW_SECONDS = 60.0  # Window for calculating requests/second
CONCURRENCY_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128]  # Buckets for latency vs concurrency


class MetricType(str, Enum):
    """Types of metrics we track."""
    LATENCY = "latency"
    THROUGHPUT = "throughput"
    MODEL = "model"
    RETRIEVAL = "retrieval"
    RELIABILITY = "reliability"
    LOAD = "load"


# =============================================================================
# Percentile Calculator
# =============================================================================

@dataclass
class PercentileSamples:
    """Thread-safe percentile sample collector."""
    samples: Deque[float] = field(default_factory=lambda: deque(maxlen=MAX_SAMPLES))
    _lock: Lock = field(default_factory=Lock)
    
    def add(self, value: float) -> None:
        """Add a sample."""
        with self._lock:
            self.samples.append(value)
    
    def get_percentiles(self) -> Dict[str, float]:
        """Get P50, P95, P99 percentiles."""
        with self._lock:
            if not self.samples:
                return {"p50": 0.0, "p95": 0.0, "p99": 0.0}
            
            sorted_samples = sorted(self.samples)
            n = len(sorted_samples)
            
            return {
                "p50": sorted_samples[int(0.50 * (n - 1))],
                "p95": sorted_samples[int(0.95 * (n - 1))],
                "p99": sorted_samples[int(0.99 * (n - 1))],
            }
    
    def get_stats(self) -> Dict[str, float]:
        """Get comprehensive statistics."""
        with self._lock:
            if not self.samples:
                return {
                    "count": 0,
                    "mean": 0.0,
                    "min": 0.0,
                    "max": 0.0,
                    "p50": 0.0,
                    "p95": 0.0,
                    "p99": 0.0,
                }
            
            sorted_samples = sorted(self.samples)
            n = len(sorted_samples)
            
            return {
                "count": n,
                "mean": statistics.mean(sorted_samples),
                "min": sorted_samples[0],
                "max": sorted_samples[-1],
                "p50": sorted_samples[int(0.50 * (n - 1))],
                "p95": sorted_samples[int(0.95 * (n - 1))],
                "p99": sorted_samples[int(0.99 * (n - 1))],
            }
    
    def clear(self) -> None:
        """Clear all samples."""
        with self._lock:
            self.samples.clear()


# =============================================================================
# Request Tracker for Throughput
# =============================================================================

@dataclass
class RequestTracker:
    """Track request timestamps for calculating requests/second."""
    timestamps: Deque[float] = field(default_factory=lambda: deque(maxlen=10000))
    _lock: Lock = field(default_factory=Lock)
    
    def record_request(self) -> None:
        """Record a request timestamp."""
        with self._lock:
            self.timestamps.append(time.time())
    
    def get_requests_per_second(self, window_seconds: float = 60.0) -> float:
        """Get requests per second over the given window."""
        with self._lock:
            now = time.time()
            cutoff = now - window_seconds
            
            # Count requests in window
            count = sum(1 for t in self.timestamps if t >= cutoff)
            
            return count / window_seconds if window_seconds > 0 else 0.0
    
    def get_peak_rps(self, bucket_seconds: float = 1.0) -> float:
        """Get peak requests per second (highest bucket)."""
        with self._lock:
            if not self.timestamps:
                return 0.0
            
            now = time.time()
            cutoff = now - SATURATION_WINDOW_SECONDS
            
            # Group timestamps into buckets
            buckets: Dict[int, int] = {}
            for t in self.timestamps:
                if t >= cutoff:
                    bucket = int(t / bucket_seconds)
                    buckets[bucket] = buckets.get(bucket, 0) + 1
            
            return max(buckets.values()) / bucket_seconds if buckets else 0.0


# =============================================================================
# Concurrency Tracker for Load Behavior
# =============================================================================

@dataclass  
class ConcurrencyTracker:
    """Track latency at different concurrency levels."""
    # Map concurrency bucket -> list of latencies
    latency_by_concurrency: Dict[int, PercentileSamples] = field(default_factory=dict)
    current_concurrency: int = 0
    peak_concurrency: int = 0
    _lock: Lock = field(default_factory=Lock)
    
    def enter_request(self) -> int:
        """Called when a request starts. Returns current concurrency."""
        with self._lock:
            self.current_concurrency += 1
            if self.current_concurrency > self.peak_concurrency:
                self.peak_concurrency = self.current_concurrency
            return self.current_concurrency
    
    def exit_request(self, latency_ms: float, concurrency_at_start: int) -> None:
        """Called when a request completes."""
        with self._lock:
            self.current_concurrency = max(0, self.current_concurrency - 1)
            
            # Find appropriate bucket
            bucket = self._get_bucket(concurrency_at_start)
            if bucket not in self.latency_by_concurrency:
                self.latency_by_concurrency[bucket] = PercentileSamples()
            
            self.latency_by_concurrency[bucket].add(latency_ms)
    
    def _get_bucket(self, concurrency: int) -> int:
        """Map concurrency to bucket."""
        for b in CONCURRENCY_BUCKETS:
            if concurrency <= b:
                return b
        return CONCURRENCY_BUCKETS[-1]
    
    def get_latency_vs_concurrency(self) -> Dict[str, Dict[str, float]]:
        """Get latency percentiles at each concurrency level."""
        with self._lock:
            result = {}
            for bucket in sorted(self.latency_by_concurrency.keys()):
                result[f"c{bucket}"] = self.latency_by_concurrency[bucket].get_percentiles()
            return result
    
    def get_p95_at_peak(self) -> float:
        """Get P95 latency at the peak concurrency bucket."""
        with self._lock:
            peak_bucket = self._get_bucket(self.peak_concurrency)
            if peak_bucket in self.latency_by_concurrency:
                return self.latency_by_concurrency[peak_bucket].get_percentiles()["p95"]
            return 0.0


# =============================================================================
# Streaming Metrics
# =============================================================================

@dataclass
class StreamingMetrics:
    """Track streaming-specific metrics."""
    # TTFT (Time To First Token) in ms
    ttft_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Full completion latency in ms
    completion_latency_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Tokens per second
    tokens_per_second_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Prompt and output size distributions
    prompt_size_samples: PercentileSamples = field(default_factory=PercentileSamples)
    output_size_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    def record_streaming_result(
        self,
        ttft_ms: float,
        completion_latency_ms: float,
        tokens_per_second: float,
        prompt_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record metrics from a streaming completion."""
        self.ttft_samples.add(ttft_ms)
        self.completion_latency_samples.add(completion_latency_ms)
        if tokens_per_second > 0:
            self.tokens_per_second_samples.add(tokens_per_second)
        if prompt_tokens > 0:
            self.prompt_size_samples.add(float(prompt_tokens))
        if output_tokens > 0:
            self.output_size_samples.add(float(output_tokens))
    
    def get_metrics(self) -> Dict[str, Dict[str, float]]:
        """Get all streaming metrics."""
        return {
            "ttft": self.ttft_samples.get_percentiles(),
            "completion_latency": self.completion_latency_samples.get_percentiles(),
            "tokens_per_second": self.tokens_per_second_samples.get_percentiles(),
            "prompt_size": self.prompt_size_samples.get_stats(),
            "output_size": self.output_size_samples.get_stats(),
        }


# =============================================================================
# Inference Metrics
# =============================================================================

@dataclass
class InferenceMetrics:
    """Track model inference metrics."""
    # Inference time in ms
    inference_time_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # By model
    inference_by_model: Dict[str, PercentileSamples] = field(default_factory=dict)
    
    _lock: Lock = field(default_factory=Lock)
    
    def record_inference(
        self,
        model: str,
        inference_time_ms: float,
    ) -> None:
        """Record an inference call."""
        self.inference_time_samples.add(inference_time_ms)
        
        with self._lock:
            if model not in self.inference_by_model:
                self.inference_by_model[model] = PercentileSamples()
            self.inference_by_model[model].add(inference_time_ms)
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get inference metrics."""
        with self._lock:
            by_model = {}
            for model, samples in self.inference_by_model.items():
                by_model[model] = samples.get_percentiles()
            
            return {
                "inference_time": self.inference_time_samples.get_percentiles(),
                "by_model": by_model,
            }


# =============================================================================
# Queue Metrics
# =============================================================================

@dataclass
class QueueMetrics:
    """Track job queue metrics."""
    # Queue delay (time from submit to start) in ms
    queue_delay_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # By job type
    queue_delay_by_type: Dict[str, PercentileSamples] = field(default_factory=dict)
    
    # Request tracker
    request_tracker: RequestTracker = field(default_factory=RequestTracker)
    
    _lock: Lock = field(default_factory=Lock)
    
    def record_job_start(self, job_type: str, queue_delay_ms: float) -> None:
        """Record when a job starts (after waiting in queue)."""
        self.queue_delay_samples.add(queue_delay_ms)
        self.request_tracker.record_request()
        
        with self._lock:
            if job_type not in self.queue_delay_by_type:
                self.queue_delay_by_type[job_type] = PercentileSamples()
            self.queue_delay_by_type[job_type].add(queue_delay_ms)
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get queue metrics."""
        with self._lock:
            by_type = {}
            for jt, samples in self.queue_delay_by_type.items():
                by_type[jt] = samples.get_percentiles()
            
            return {
                "queue_delay": self.queue_delay_samples.get_percentiles(),
                "by_job_type": by_type,
                "requests_per_second": self.request_tracker.get_requests_per_second(),
                "peak_rps": self.request_tracker.get_peak_rps(),
            }


# =============================================================================
# Retrieval Metrics (Enhanced)
# =============================================================================

@dataclass
class EnhancedRetrievalMetrics:
    """Enhanced retrieval metrics with P99 and quality metrics."""
    # Latency samples for each stage
    query_latency: PercentileSamples = field(default_factory=PercentileSamples)
    retrieval_latency: PercentileSamples = field(default_factory=PercentileSamples)
    expansion_latency: PercentileSamples = field(default_factory=PercentileSamples)
    ranking_latency: PercentileSamples = field(default_factory=PercentileSamples)
    assembly_latency: PercentileSamples = field(default_factory=PercentileSamples)
    total_latency: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Quality metrics
    recall_at_k_samples: Dict[int, PercentileSamples] = field(default_factory=dict)  # k -> recall samples
    mrr_samples: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Counters for latest retrieval
    _last_counters: Dict[str, int] = field(default_factory=dict)
    
    def record_retrieval(
        self,
        query_ms: float,
        retrieval_ms: float,
        expansion_ms: float,
        ranking_ms: float,
        assembly_ms: float,
        total_ms: float,
        counters: Optional[Dict[str, int]] = None,
    ) -> Dict[str, float]:
        """Record a retrieval operation. Returns stage P95s."""
        self.query_latency.add(query_ms)
        self.retrieval_latency.add(retrieval_ms)
        self.expansion_latency.add(expansion_ms)
        self.ranking_latency.add(ranking_ms)
        self.assembly_latency.add(assembly_ms)
        self.total_latency.add(total_ms)
        
        if counters:
            self._last_counters = counters
        
        return {
            "query": self.query_latency.get_percentiles()["p95"],
            "retrieval": self.retrieval_latency.get_percentiles()["p95"],
            "expansion": self.expansion_latency.get_percentiles()["p95"],
            "ranking": self.ranking_latency.get_percentiles()["p95"],
            "assembly": self.assembly_latency.get_percentiles()["p95"],
        }
    
    def record_quality_metrics(
        self,
        recall_at_k: Dict[int, float],  # k -> recall value
        mrr: float,
    ) -> None:
        """Record quality metrics from evaluation."""
        for k, recall in recall_at_k.items():
            if k not in self.recall_at_k_samples:
                self.recall_at_k_samples[k] = PercentileSamples()
            self.recall_at_k_samples[k].add(recall)
        
        self.mrr_samples.add(mrr)
    
    def get_latency_metrics(self) -> Dict[str, Dict[str, float]]:
        """Get latency metrics with P50, P95, P99."""
        return {
            "query": self.query_latency.get_percentiles(),
            "retrieval": self.retrieval_latency.get_percentiles(),
            "expansion": self.expansion_latency.get_percentiles(),
            "ranking": self.ranking_latency.get_percentiles(),
            "assembly": self.assembly_latency.get_percentiles(),
            "total": self.total_latency.get_percentiles(),
        }
    
    def get_quality_metrics(self) -> Dict[str, Any]:
        """Get quality metrics."""
        recall_stats = {}
        for k, samples in self.recall_at_k_samples.items():
            recall_stats[f"recall_at_{k}"] = samples.get_stats()
        
        return {
            **recall_stats,
            "mrr": self.mrr_samples.get_stats(),
        }
    
    def get_counters(self) -> Dict[str, int]:
        """Get last retrieval counters."""
        return dict(self._last_counters)


# =============================================================================
# Reliability Metrics
# =============================================================================

@dataclass
class ReliabilityMetrics:
    """Track reliability metrics."""
    total_requests: int = 0
    errors: int = 0
    timeouts: int = 0
    
    # Cold start tracking
    cold_start_count: int = 0
    cold_start_latency: PercentileSamples = field(default_factory=PercentileSamples)
    
    # Error details
    error_types: Dict[str, int] = field(default_factory=dict)
    
    _lock: Lock = field(default_factory=Lock)
    
    def record_request(self, success: bool, is_timeout: bool = False, error_type: Optional[str] = None) -> None:
        """Record a request outcome."""
        with self._lock:
            self.total_requests += 1
            if not success:
                self.errors += 1
                if is_timeout:
                    self.timeouts += 1
                if error_type:
                    self.error_types[error_type] = self.error_types.get(error_type, 0) + 1
    
    def record_cold_start(self, latency_ms: float) -> None:
        """Record a cold start."""
        with self._lock:
            self.cold_start_count += 1
            self.cold_start_latency.add(latency_ms)
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get reliability metrics."""
        with self._lock:
            error_rate = self.errors / self.total_requests if self.total_requests > 0 else 0.0
            timeout_rate = self.timeouts / self.total_requests if self.total_requests > 0 else 0.0
            
            return {
                "total_requests": self.total_requests,
                "errors": self.errors,
                "error_rate": error_rate,
                "timeout_rate": timeout_rate,
                "timeouts": self.timeouts,
                "cold_starts": self.cold_start_count,
                "cold_start_latency": self.cold_start_latency.get_percentiles(),
                "error_types": dict(self.error_types),
            }


# =============================================================================
# Main Metrics Collector
# =============================================================================

class EngineMetricsCollector:
    """
    Central metrics collector for the AI Engine.
    
    Provides:
    - Latency: TTFT P50/P95, full completion P50/P95, queue delay P50/P95
    - Throughput: tokens/second P50/P95, requests/second at saturation
    - Model: inference time P50/P95, prompt/output size distribution
    - Retrieval: latency P50/P95/P99, Recall@k, MRR
    - Reliability: error rate, timeout rate, cold start latency
    - Load: latency vs concurrency curve, P95 under peak load
    """
    
    def __init__(self):
        self.streaming = StreamingMetrics()
        self.inference = InferenceMetrics()
        self.queue = QueueMetrics()
        self.retrieval = EnhancedRetrievalMetrics()
        self.reliability = ReliabilityMetrics()
        self.concurrency = ConcurrencyTracker()
        
        # Track initialization for cold start detection
        self._initialized_at: Optional[float] = None
        self._is_cold = True
    
    def mark_warm(self) -> None:
        """Mark the engine as warmed up (first request completed)."""
        if self._is_cold:
            self._is_cold = False
            self._initialized_at = time.time()
    
    @property
    def is_cold(self) -> bool:
        return self._is_cold
    
    # -------------------------------------------------------------------------
    # Streaming metrics
    # -------------------------------------------------------------------------
    
    def record_streaming_completion(
        self,
        ttft_ms: float,
        total_latency_ms: float,
        tokens: int,
        prompt_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record a streaming completion."""
        tokens_per_second = tokens / (total_latency_ms / 1000) if total_latency_ms > 0 else 0
        self.streaming.record_streaming_result(
            ttft_ms=ttft_ms,
            completion_latency_ms=total_latency_ms,
            tokens_per_second=tokens_per_second,
            prompt_tokens=prompt_tokens,
            output_tokens=output_tokens,
        )
        
        if self._is_cold:
            self.reliability.record_cold_start(total_latency_ms)
            self.mark_warm()
    
    # -------------------------------------------------------------------------
    # Inference metrics
    # -------------------------------------------------------------------------
    
    def record_inference(
        self,
        model: str,
        inference_time_ms: float,
        success: bool = True,
        is_timeout: bool = False,
        error_type: Optional[str] = None,
    ) -> None:
        """Record a model inference."""
        self.inference.record_inference(model, inference_time_ms)
        self.reliability.record_request(success, is_timeout, error_type)
        
        if self._is_cold:
            self.reliability.record_cold_start(inference_time_ms)
            self.mark_warm()
    
    # -------------------------------------------------------------------------
    # Queue metrics
    # -------------------------------------------------------------------------
    
    def record_job_start(self, job_type: str, queue_delay_ms: float) -> int:
        """Record a job starting. Returns concurrency at start."""
        self.queue.record_job_start(job_type, queue_delay_ms)
        return self.concurrency.enter_request()
    
    def record_job_complete(
        self,
        latency_ms: float,
        concurrency_at_start: int,
        success: bool = True,
        is_timeout: bool = False,
        error_type: Optional[str] = None,
    ) -> None:
        """Record a job completing."""
        self.concurrency.exit_request(latency_ms, concurrency_at_start)
        self.reliability.record_request(success, is_timeout, error_type)
    
    # -------------------------------------------------------------------------
    # Retrieval metrics
    # -------------------------------------------------------------------------
    
    def record_retrieval(
        self,
        query_ms: float,
        retrieval_ms: float,
        expansion_ms: float,
        ranking_ms: float,
        assembly_ms: float,
        total_ms: float,
        counters: Optional[Dict[str, int]] = None,
    ) -> Dict[str, float]:
        """Record a retrieval operation. Returns stage P95s."""
        return self.retrieval.record_retrieval(
            query_ms, retrieval_ms, expansion_ms, ranking_ms, assembly_ms, total_ms, counters
        )
    
    def record_retrieval_quality(
        self,
        recall_at_k: Dict[int, float],
        mrr: float,
    ) -> None:
        """Record retrieval quality metrics."""
        self.retrieval.record_quality_metrics(recall_at_k, mrr)
    
    # -------------------------------------------------------------------------
    # Get all metrics
    # -------------------------------------------------------------------------
    
    def get_all_metrics(self) -> Dict[str, Any]:
        """Get all collected metrics."""
        return {
            "latency": {
                "ttft": self.streaming.ttft_samples.get_percentiles(),
                "completion": self.streaming.completion_latency_samples.get_percentiles(),
                "queue_delay": self.queue.queue_delay_samples.get_percentiles(),
            },
            "throughput": {
                "tokens_per_second": self.streaming.tokens_per_second_samples.get_percentiles(),
                "requests_per_second": self.queue.request_tracker.get_requests_per_second(),
                "peak_rps": self.queue.request_tracker.get_peak_rps(),
            },
            "model": self.inference.get_metrics(),
            "retrieval": {
                "latency": self.retrieval.get_latency_metrics(),
                "quality": self.retrieval.get_quality_metrics(),
                "counters": self.retrieval.get_counters(),
            },
            "reliability": self.reliability.get_metrics(),
            "load": {
                "latency_vs_concurrency": self.concurrency.get_latency_vs_concurrency(),
                "current_concurrency": self.concurrency.current_concurrency,
                "peak_concurrency": self.concurrency.peak_concurrency,
                "p95_at_peak": self.concurrency.get_p95_at_peak(),
            },
            "prompt_output_distribution": {
                "prompt_size": self.streaming.prompt_size_samples.get_stats(),
                "output_size": self.streaming.output_size_samples.get_stats(),
            },
        }
    
    def get_summary(self) -> Dict[str, Any]:
        """Get a condensed summary for quick monitoring."""
        streaming_metrics = self.streaming.get_metrics()
        reliability = self.reliability.get_metrics()
        retrieval_latency = self.retrieval.get_latency_metrics()
        
        return {
            "ttft_p50": streaming_metrics["ttft"]["p50"],
            "ttft_p95": streaming_metrics["ttft"]["p95"],
            "completion_p50": streaming_metrics["completion_latency"]["p50"],
            "completion_p95": streaming_metrics["completion_latency"]["p95"],
            "queue_delay_p50": self.queue.queue_delay_samples.get_percentiles()["p50"],
            "queue_delay_p95": self.queue.queue_delay_samples.get_percentiles()["p95"],
            "tokens_per_second_p50": streaming_metrics["tokens_per_second"]["p50"],
            "tokens_per_second_p95": streaming_metrics["tokens_per_second"]["p95"],
            "retrieval_p50": retrieval_latency["total"]["p50"],
            "retrieval_p95": retrieval_latency["total"]["p95"],
            "retrieval_p99": retrieval_latency["total"]["p99"],
            "error_rate": reliability["error_rate"],
            "timeout_rate": reliability["timeout_rate"],
            "cold_start_latency_p95": reliability["cold_start_latency"]["p95"],
            "p95_at_peak_load": self.concurrency.get_p95_at_peak(),
            "current_concurrency": self.concurrency.current_concurrency,
        }


# =============================================================================
# Global Instance
# =============================================================================

_metrics_collector: Optional[EngineMetricsCollector] = None


def get_metrics_collector() -> EngineMetricsCollector:
    """Get or create the global metrics collector."""
    global _metrics_collector
    if _metrics_collector is None:
        _metrics_collector = EngineMetricsCollector()
    return _metrics_collector


def reset_metrics_collector() -> None:
    """Reset the global metrics collector (for testing)."""
    global _metrics_collector
    _metrics_collector = None


# =============================================================================
# Context Manager for Timing
# =============================================================================

class MetricTimer:
    """Context manager for timing operations."""
    
    def __init__(self, callback: callable):
        self.callback = callback
        self.start_time: Optional[float] = None
        self.duration_ms: float = 0.0
    
    def __enter__(self) -> "MetricTimer":
        self.start_time = time.time()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.start_time:
            self.duration_ms = (time.time() - self.start_time) * 1000
            self.callback(self.duration_ms)
    
    @property
    def elapsed_ms(self) -> float:
        if self.start_time:
            return (time.time() - self.start_time) * 1000
        return 0.0


class StreamingTimer:
    """Timer for streaming operations that tracks TTFT and total latency."""
    
    def __init__(self, collector: EngineMetricsCollector, model: str = "unknown"):
        self.collector = collector
        self.model = model
        self.start_time: Optional[float] = None
        self.first_token_time: Optional[float] = None
        self.tokens: int = 0
        self.prompt_tokens: int = 0
        self.output_tokens: int = 0
    
    def start(self) -> None:
        """Start timing."""
        self.start_time = time.time()
    
    def record_first_token(self) -> None:
        """Record when first token arrives."""
        if self.first_token_time is None:
            self.first_token_time = time.time()
    
    def record_token(self, count: int = 1) -> None:
        """Record tokens received."""
        self.tokens += count
        self.output_tokens += count
    
    def set_prompt_tokens(self, count: int) -> None:
        """Set prompt token count."""
        self.prompt_tokens = count
    
    def finish(self, success: bool = True, is_timeout: bool = False, error_type: Optional[str] = None) -> None:
        """Finish timing and record metrics."""
        if self.start_time is None:
            return
        
        end_time = time.time()
        total_latency_ms = (end_time - self.start_time) * 1000
        
        ttft_ms = 0.0
        if self.first_token_time:
            ttft_ms = (self.first_token_time - self.start_time) * 1000
        
        # Record streaming metrics
        self.collector.record_streaming_completion(
            ttft_ms=ttft_ms,
            total_latency_ms=total_latency_ms,
            tokens=self.tokens,
            prompt_tokens=self.prompt_tokens,
            output_tokens=self.output_tokens,
        )
        
        # Record inference metrics
        self.collector.record_inference(
            model=self.model,
            inference_time_ms=total_latency_ms,
            success=success,
            is_timeout=is_timeout,
            error_type=error_type,
        )
