"""GPU HMR agent package — see docs/GPU_HMR_ULTRAPLAN.md §5.6.

Each module here is a discrete agent with a strict input/output schema.
Non-LLM agents (gpu_detect, gpu_mod_delta classifier, abi_stamper,
gpu_error_triage) live next to LLM agents (kernel_splitter,
launch_graph_extractor, gpu_mod_delta patcher, gpu_healer) so the
import path for the GPU pipeline is uniform: `agents.<name>`.
"""
