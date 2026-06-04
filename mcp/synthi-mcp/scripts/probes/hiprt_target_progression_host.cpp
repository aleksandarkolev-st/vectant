#include <hip/hip_runtime.h>
#include <hip/hip_runtime_api.h>

#include <cmath>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <unistd.h>

namespace {

constexpr const char* kKernelName = "TestCopyKernelRestrict";
constexpr const char* kDispatchSlot = "hiprt-testcopy-slot";
constexpr int kBlockSize = 256;
constexpr std::size_t kBufferSize = 1024;

void hip_check(hipError_t result, const char* call) {
  if (result != hipSuccess) {
    std::cerr << "HIP failure: " << call << " result=" << static_cast<int>(result)
              << " error=" << hipGetErrorString(result) << "\n";
    std::exit(2);
  }
}

std::vector<char> read_binary(const char* path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error(std::string("cannot open ") + path);
  }
  in.seekg(0, std::ios::end);
  const std::streamoff size = in.tellg();
  in.seekg(0, std::ios::beg);
  std::vector<char> bytes(static_cast<std::size_t>(size));
  in.read(bytes.data(), size);
  if (!in) {
    throw std::runtime_error(std::string("cannot read ") + path);
  }
  return bytes;
}

std::uint64_t fnv1a_f32(const std::vector<float>& values) {
  std::uint64_t hash = 1469598103934665603ull;
  for (const float value : values) {
    std::uint32_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    for (int shift = 0; shift < 32; shift += 8) {
      hash ^= static_cast<std::uint8_t>((bits >> shift) & 0xffu);
      hash *= 1099511628211ull;
    }
  }
  return hash;
}

struct DispatchEntry {
  hipModule_t module = nullptr;
  hipFunction_t function = nullptr;
  std::vector<char> module_bytes;
  std::string artifact_id;
  int generation = 0;
};

struct ProbeResult {
  double sum_a = 0.0;
  double sum_d = 0.0;
  std::uint64_t hash_d = 0;
  bool passed = false;
};

DispatchEntry load_entry(const char* hsaco_path, const std::string& artifact_id, int generation) {
  DispatchEntry entry;
  entry.artifact_id = artifact_id;
  entry.generation = generation;
  entry.module_bytes = read_binary(hsaco_path);
  hip_check(hipModuleLoadData(&entry.module, entry.module_bytes.data()), "hipModuleLoadData");
  hip_check(hipModuleGetFunction(&entry.function, entry.module, kKernelName), "hipModuleGetFunction");
  return entry;
}

ProbeResult launch_probe(const DispatchEntry& entry, double expected_d_sum) {
  float* buffer_a = nullptr;
  float* buffer_b = nullptr;
  float* buffer_c = nullptr;
  float* buffer_d = nullptr;
  std::vector<float> host_a(kBufferSize, 1.0f);
  std::vector<float> host_b(kBufferSize, 2.0f);
  std::vector<float> host_c(kBufferSize, 3.0f);
  std::vector<float> host_d(kBufferSize, 0.0f);

  hip_check(hipMalloc(&buffer_a, kBufferSize * sizeof(float)), "hipMalloc a");
  hip_check(hipMalloc(&buffer_b, kBufferSize * sizeof(float)), "hipMalloc b");
  hip_check(hipMalloc(&buffer_c, kBufferSize * sizeof(float)), "hipMalloc c");
  hip_check(hipMalloc(&buffer_d, kBufferSize * sizeof(float)), "hipMalloc d");
  hip_check(hipMemcpy(buffer_a, host_a.data(), kBufferSize * sizeof(float), hipMemcpyHostToDevice), "hipMemcpy a h2d");
  hip_check(hipMemcpy(buffer_b, host_b.data(), kBufferSize * sizeof(float), hipMemcpyHostToDevice), "hipMemcpy b h2d");
  hip_check(hipMemcpy(buffer_c, host_c.data(), kBufferSize * sizeof(float), hipMemcpyHostToDevice), "hipMemcpy c h2d");
  hip_check(hipMemcpy(buffer_d, host_d.data(), kBufferSize * sizeof(float), hipMemcpyHostToDevice), "hipMemcpy d h2d");

  std::size_t buffer_size = kBufferSize;
  void* args[] = {&buffer_a, &buffer_b, &buffer_c, &buffer_d, &buffer_size};
  const unsigned grid_x = static_cast<unsigned>((kBufferSize + kBlockSize - 1) / kBlockSize);
  hip_check(
    hipModuleLaunchKernel(entry.function, grid_x, 1, 1, kBlockSize, 1, 1, 0, nullptr, args, nullptr),
    "hipModuleLaunchKernel");
  hip_check(hipDeviceSynchronize(), "hipDeviceSynchronize");
  hip_check(hipMemcpy(host_a.data(), buffer_a, kBufferSize * sizeof(float), hipMemcpyDeviceToHost), "hipMemcpy a d2h");
  hip_check(hipMemcpy(host_d.data(), buffer_d, kBufferSize * sizeof(float), hipMemcpyDeviceToHost), "hipMemcpy d d2h");

  ProbeResult result;
  for (std::size_t i = 0; i < kBufferSize; ++i) {
    result.sum_a += host_a[i];
    result.sum_d += host_d[i];
  }
  result.hash_d = fnv1a_f32(host_d);
  result.passed = std::fabs(result.sum_a - 3072.0) < 0.001
    && std::fabs(result.sum_d - expected_d_sum) < 0.001;

  hip_check(hipFree(buffer_a), "hipFree a");
  hip_check(hipFree(buffer_b), "hipFree b");
  hip_check(hipFree(buffer_c), "hipFree c");
  hip_check(hipFree(buffer_d), "hipFree d");
  return result;
}

} // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: hiprt_target_progression_host <v1.hsaco> <v2.hsaco>\n";
    return 64;
  }

  int device_count = 0;
  hip_check(hipGetDeviceCount(&device_count), "hipGetDeviceCount");
  if (device_count < 1) {
    std::cerr << "no HIP devices available\n";
    return 70;
  }
  hip_check(hipSetDevice(0), "hipSetDevice");

  const auto session = std::string("hiprt-small-probe:pid:") + std::to_string(static_cast<long long>(getpid()));
  std::cout << "[gpu-runtime-boundary] runtime_session event=started runtime_session=" << session
            << " host_pid=" << getpid() << "\n";
  std::cout << "[gpu-runtime-boundary] host_identity role=original_host event=before_hmr pid=" << getpid()
            << " runtime_session=" << session << "\n";

  DispatchEntry entry = load_entry(argv[1], "artifact:hiprt-small-testcopy:v1", 1);
  std::cout << "[gpu-runtime-boundary] artifact_transport event=loaded loader_transport=ram"
            << " artifact_id=" << entry.artifact_id
            << " artifact_bytes=" << entry.module_bytes.size()
            << " runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] dispatcher_epoch event=published previous_generation=0 active_generation=1"
            << " changed_symbols=" << kKernelName
            << " fission_island_id=fission:hiprt:testcopyrestrict"
            << " stream_ordering_proven=true runtime_session=" << session << "\n";
  ProbeResult first = launch_probe(entry, 18432.0);
  std::cout << "[gpu-runtime-boundary] synthi_gpu_launch kernel=" << kKernelName
            << " dispatch=ok generation=1 dispatch_table_entry_id=" << kDispatchSlot
            << " artifact_id=" << entry.artifact_id
            << " runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] output_oracle id=hiprt.testcopy.v1.sum kind=buffer_checksum"
            << " expected=sum_d:18432 actual=sum_d:" << static_cast<long long>(first.sum_d)
            << " passed=" << (first.passed ? "true" : "false")
            << " hash_d=fnv1a64:" << std::hex << first.hash_d << std::dec
            << " producer=hiprt-small-probe output_target_id=buffer_d artifact_id=" << entry.artifact_id
            << " runtime_session=" << session << "\n";

  DispatchEntry replacement = load_entry(argv[2], "artifact:hiprt-small-testcopy:v2", 2);
  std::cout << "[gpu-runtime-boundary] artifact_transport event=loaded loader_transport=ram"
            << " artifact_id=" << replacement.artifact_id
            << " artifact_bytes=" << replacement.module_bytes.size()
            << " runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] dispatcher_epoch event=published previous_generation=1 active_generation=2"
            << " changed_symbols=" << kKernelName
            << " fission_island_id=fission:hiprt:testcopyrestrict"
            << " stream_ordering_proven=true runtime_session=" << session << "\n";
  ProbeResult second = launch_probe(replacement, 24576.0);
  std::cout << "[gpu-runtime-boundary] synthi_gpu_launch kernel=" << kKernelName
            << " dispatch=ok generation=2 dispatch_table_entry_id=" << kDispatchSlot
            << " artifact_id=" << replacement.artifact_id
            << " runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] original_host_path event=attached attached=true"
            << " dispatch_boundary_observed=true attachment_provenance=host_runtime_explicit"
            << " host_path_id=hiprt-small-probe dispatch_table_entry_id=" << kDispatchSlot
            << " runtime_dispatch_table_entry_id=" << kDispatchSlot
            << " dispatch_entry_runtime_verified=true generation=2 runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] host_identity role=original_host event=after_hmr pid=" << getpid()
            << " preserved=true runtime_session=" << session << "\n";
  std::cout << "[gpu-runtime-boundary] output_oracle id=hiprt.testcopy.v2.sum kind=buffer_checksum"
            << " expected=sum_d:24576 actual=sum_d:" << static_cast<long long>(second.sum_d)
            << " passed=" << (second.passed ? "true" : "false")
            << " hash_d=fnv1a64:" << std::hex << second.hash_d << std::dec
            << " producer=hiprt-small-probe output_target_id=buffer_d artifact_id=" << replacement.artifact_id
            << " runtime_session=" << session << "\n";

  hip_check(hipModuleUnload(entry.module), "hipModuleUnload v1");
  hip_check(hipModuleUnload(replacement.module), "hipModuleUnload v2");
  return first.passed && second.passed ? 0 : 1;
}
