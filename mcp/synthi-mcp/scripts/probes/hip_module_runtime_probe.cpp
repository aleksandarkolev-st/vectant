#include <hip/hip_runtime_api.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <process.h>
static int current_pid() { return _getpid(); }
#else
#include <unistd.h>
static int current_pid() { return static_cast<int>(getpid()); }
#endif

namespace {

struct Dim3 {
  unsigned x = 1;
  unsigned y = 1;
  unsigned z = 1;
};

struct Plan {
  std::string kernel_name;
  std::string artifact_hash_before;
  std::string artifact_hash_after;
  std::string dispatch_binding;
  std::string compile_target;
  Dim3 grid_dim;
  Dim3 block_dim;
  unsigned shared_mem_bytes = 0;
  std::size_t element_count = 0;
  float scale = 1.0f;
  float bias = 0.0f;
  std::vector<float> input_values;
  std::vector<float> expected_before;
  std::vector<float> expected_after;
};

struct DispatchResult {
  int epoch = 0;
  std::string artifact_hash;
  std::string dispatch_id;
  float gpu_ms = 0.0f;
  bool passed = false;
  std::vector<float> values;
};

void hip_check(hipError_t result, const char* call) {
  if (result != hipSuccess) {
    std::cerr << "HIP failure: " << call << " result=" << static_cast<int>(result)
              << " error=" << hipGetErrorString(result) << "\n";
    std::exit(2);
  }
}

std::string trim(const std::string& value) {
  const auto start = value.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) return "";
  const auto end = value.find_last_not_of(" \t\r\n");
  return value.substr(start, end - start + 1);
}

std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (const char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(static_cast<unsigned char>(ch));
        } else {
          out << ch;
        }
    }
  }
  return out.str();
}

std::string json_string(const std::string& value) {
  return "\"" + json_escape(value) + "\"";
}

std::vector<char> read_binary(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open " + path);
  in.seekg(0, std::ios::end);
  const std::streamoff size = in.tellg();
  in.seekg(0, std::ios::beg);
  std::vector<char> bytes(static_cast<std::size_t>(size));
  in.read(bytes.data(), size);
  if (!in) throw std::runtime_error("cannot read " + path);
  return bytes;
}

void write_binary(const std::string& path, const std::vector<float>& values) {
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("cannot write " + path);
  out.write(reinterpret_cast<const char*>(values.data()), static_cast<std::streamsize>(values.size() * sizeof(float)));
  if (!out) throw std::runtime_error("cannot flush " + path);
}

std::map<std::string, std::string> read_plan_map(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot open plan " + path);
  std::map<std::string, std::string> plan;
  std::string line;
  while (std::getline(in, line)) {
    const std::string cleaned = trim(line);
    if (cleaned.empty() || cleaned[0] == '#') continue;
    const auto split = cleaned.find('=');
    if (split == std::string::npos) continue;
    plan[trim(cleaned.substr(0, split))] = trim(cleaned.substr(split + 1));
  }
  return plan;
}

std::string required(const std::map<std::string, std::string>& plan, const std::string& key) {
  const auto found = plan.find(key);
  if (found == plan.end() || found->second.empty()) {
    throw std::runtime_error("plan missing " + key);
  }
  return found->second;
}

unsigned parse_unsigned(const std::map<std::string, std::string>& plan, const std::string& key, unsigned fallback) {
  const auto found = plan.find(key);
  if (found == plan.end() || found->second.empty()) return fallback;
  return static_cast<unsigned>(std::stoul(found->second));
}

float parse_float(const std::map<std::string, std::string>& plan, const std::string& key, float fallback) {
  const auto found = plan.find(key);
  if (found == plan.end() || found->second.empty()) return fallback;
  return std::stof(found->second);
}

std::vector<float> parse_float_list(const std::string& value) {
  std::vector<float> out;
  std::stringstream stream(value);
  std::string token;
  while (std::getline(stream, token, ',')) {
    const std::string cleaned = trim(token);
    if (!cleaned.empty()) out.push_back(std::stof(cleaned));
  }
  return out;
}

Dim3 parse_dim(const std::map<std::string, std::string>& plan, const std::string& prefix) {
  return {
    parse_unsigned(plan, prefix + "_x", 1),
    parse_unsigned(plan, prefix + "_y", 1),
    parse_unsigned(plan, prefix + "_z", 1),
  };
}

Plan load_plan(const std::string& path) {
  const auto map = read_plan_map(path);
  Plan plan;
  plan.kernel_name = required(map, "kernel_name");
  plan.artifact_hash_before = required(map, "artifact_hash_before");
  plan.artifact_hash_after = required(map, "artifact_hash_after");
  plan.dispatch_binding = required(map, "dispatch_binding");
  plan.compile_target = required(map, "compile_target");
  plan.grid_dim = parse_dim(map, "grid");
  plan.block_dim = parse_dim(map, "block");
  plan.shared_mem_bytes = parse_unsigned(map, "shared_mem_bytes", 0);
  plan.element_count = static_cast<std::size_t>(parse_unsigned(map, "element_count", 0));
  plan.scale = parse_float(map, "scale", 1.0f);
  plan.bias = parse_float(map, "bias", 0.0f);
  plan.input_values = parse_float_list(required(map, "input_values"));
  plan.expected_before = parse_float_list(required(map, "expected_before_values"));
  plan.expected_after = parse_float_list(required(map, "expected_after_values"));
  if (plan.element_count == 0) plan.element_count = plan.input_values.size();
  if (plan.input_values.size() != plan.element_count
      || plan.expected_before.size() != plan.element_count
      || plan.expected_after.size() != plan.element_count) {
    throw std::runtime_error("plan vector lengths must match element_count");
  }
  return plan;
}

bool float_vectors_match(const std::vector<float>& actual, const std::vector<float>& expected, float tolerance) {
  if (actual.size() != expected.size()) return false;
  for (std::size_t i = 0; i < actual.size(); ++i) {
    if (std::fabs(actual[i] - expected[i]) > tolerance) return false;
  }
  return true;
}

std::string float_array_json(const std::vector<float>& values) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ",";
    out << std::setprecision(9) << values[i];
  }
  out << "]";
  return out.str();
}

std::string dim_json(const Dim3& dim) {
  std::ostringstream out;
  out << "{\"x\":" << dim.x << ",\"y\":" << dim.y << ",\"z\":" << dim.z << "}";
  return out.str();
}

struct ModuleEntry {
  hipModule_t module = nullptr;
  hipFunction_t function = nullptr;
  std::vector<char> bytes;
};

ModuleEntry load_module(const std::string& hsaco_path, const Plan& plan) {
  ModuleEntry entry;
  entry.bytes = read_binary(hsaco_path);
  hip_check(hipModuleLoadData(&entry.module, entry.bytes.data()), "hipModuleLoadData");
  hip_check(hipModuleGetFunction(&entry.function, entry.module, plan.kernel_name.c_str()), "hipModuleGetFunction");
  return entry;
}

DispatchResult dispatch_module(const ModuleEntry& entry, const Plan& plan, int epoch, const std::string& artifact_hash) {
  DispatchResult result;
  result.epoch = epoch;
  result.artifact_hash = artifact_hash;
  result.dispatch_id = "hip-module-dispatch-epoch-" + std::to_string(epoch);

  float* device_input = nullptr;
  float* device_output = nullptr;
  hipStream_t stream = nullptr;
  hipEvent_t start = nullptr;
  hipEvent_t stop = nullptr;

  const std::size_t byte_count = plan.element_count * sizeof(float);
  result.values.assign(plan.element_count, 0.0f);

  hip_check(hipStreamCreate(&stream), "hipStreamCreate");
  hip_check(hipEventCreate(&start), "hipEventCreate start");
  hip_check(hipEventCreate(&stop), "hipEventCreate stop");
  hip_check(hipMalloc(&device_input, byte_count), "hipMalloc input");
  hip_check(hipMalloc(&device_output, byte_count), "hipMalloc output");
  hip_check(hipMemcpyAsync(device_input, plan.input_values.data(), byte_count, hipMemcpyHostToDevice, stream), "hipMemcpyAsync input");
  hip_check(hipMemsetAsync(device_output, 0, byte_count, stream), "hipMemsetAsync output");

  unsigned int n = static_cast<unsigned int>(plan.element_count);
  float scale = plan.scale;
  float bias = plan.bias;
  void* args[] = {&device_output, &device_input, &scale, &bias, &n};

  hip_check(hipEventRecord(start, stream), "hipEventRecord start");
  hip_check(
    hipModuleLaunchKernel(
      entry.function,
      plan.grid_dim.x, plan.grid_dim.y, plan.grid_dim.z,
      plan.block_dim.x, plan.block_dim.y, plan.block_dim.z,
      plan.shared_mem_bytes,
      stream,
      args,
      nullptr),
    "hipModuleLaunchKernel");
  hip_check(hipEventRecord(stop, stream), "hipEventRecord stop");
  hip_check(hipMemcpyAsync(result.values.data(), device_output, byte_count, hipMemcpyDeviceToHost, stream), "hipMemcpyAsync output");
  hip_check(hipStreamSynchronize(stream), "hipStreamSynchronize");
  hip_check(hipEventElapsedTime(&result.gpu_ms, start, stop), "hipEventElapsedTime");

  result.passed = float_vectors_match(
    result.values,
    epoch == 1 ? plan.expected_before : plan.expected_after,
    0.00001f);

  hip_check(hipFree(device_input), "hipFree input");
  hip_check(hipFree(device_output), "hipFree output");
  hip_check(hipEventDestroy(start), "hipEventDestroy start");
  hip_check(hipEventDestroy(stop), "hipEventDestroy stop");
  hip_check(hipStreamDestroy(stream), "hipStreamDestroy");
  return result;
}

void write_runtime_json(
  const std::string& path,
  const Plan& plan,
  const DispatchResult& before,
  const DispatchResult& after,
  const std::string& session,
  const std::string& device_name,
  const std::string& device_uuid,
  int process_id) {
  std::ofstream out(path);
  if (!out) throw std::runtime_error("cannot write runtime json " + path);
  out << "{\n";
  out << "  \"schemaVersion\":\"synthi.gpu.hmr.hip_module_runtime_trace.v1\",\n";
  out << "  \"runtimeSessionId\":" << json_string(session) << ",\n";
  out << "  \"processId\":" << json_string(std::to_string(process_id)) << ",\n";
  out << "  \"device\":{\"backend\":\"hip\",\"name\":" << json_string(device_name)
      << ",\"device_uuid\":" << json_string(device_uuid) << ",\"compile_target\":"
      << json_string(plan.compile_target) << "},\n";
  out << "  \"loaderEvents\":[\n";
  out << "    {\"id\":\"hip-module-loader-1\",\"artifact_hash\":" << json_string(plan.artifact_hash_before)
      << ",\"epoch\":1,\"api\":\"hipModuleLoadData\"},\n";
  out << "    {\"id\":\"hip-module-loader-2\",\"artifact_hash\":" << json_string(plan.artifact_hash_after)
      << ",\"epoch\":2,\"api\":\"hipModuleLoadData\"}\n";
  out << "  ],\n";
  out << "  \"symbolEvents\":[\n";
  out << "    {\"epoch\":1,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name) << "},\n";
  out << "    {\"epoch\":2,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name) << "}\n";
  out << "  ],\n";
  out << "  \"epochEvents\":[\n";
  out << "    {\"id\":\"hip-module-publish-1\",\"epoch\":1,\"artifact_hash\":" << json_string(plan.artifact_hash_before) << "},\n";
  out << "    {\"id\":\"hip-module-publish-2\",\"epoch\":2,\"artifact_hash\":" << json_string(plan.artifact_hash_after) << "}\n";
  out << "  ],\n";
  out << "  \"dispatchEvents\":[\n";
  out << "    {\"id\":" << json_string(before.dispatch_id) << ",\"epoch\":1,\"artifact_hash\":"
      << json_string(before.artifact_hash) << ",\"launch_api\":\"hipModuleLaunchKernel\",\"grid_dim\":"
      << dim_json(plan.grid_dim) << ",\"block_dim\":" << dim_json(plan.block_dim)
      << ",\"shared_mem_bytes\":" << plan.shared_mem_bytes << ",\"stream\":\"hipStreamCreate\",\"gpu_ms\":"
      << before.gpu_ms << ",\"passed\":" << (before.passed ? "true" : "false") << "},\n";
  out << "    {\"id\":" << json_string(after.dispatch_id) << ",\"epoch\":2,\"artifact_hash\":"
      << json_string(after.artifact_hash) << ",\"launch_api\":\"hipModuleLaunchKernel\",\"grid_dim\":"
      << dim_json(plan.grid_dim) << ",\"block_dim\":" << dim_json(plan.block_dim)
      << ",\"shared_mem_bytes\":" << plan.shared_mem_bytes << ",\"stream\":\"hipStreamCreate\",\"gpu_ms\":"
      << after.gpu_ms << ",\"passed\":" << (after.passed ? "true" : "false") << "}\n";
  out << "  ],\n";
  out << "  \"outputEvents\":[\n";
  out << "    {\"id\":\"hip-module-output-1\",\"after_dispatch_id\":" << json_string(before.dispatch_id)
      << ",\"epoch\":1,\"artifact_hash\":" << json_string(before.artifact_hash)
      << ",\"passed\":" << (before.passed ? "true" : "false")
      << ",\"values\":" << float_array_json(before.values) << "},\n";
  out << "    {\"id\":\"hip-module-output-2\",\"after_dispatch_id\":" << json_string(after.dispatch_id)
      << ",\"epoch\":2,\"artifact_hash\":" << json_string(after.artifact_hash)
      << ",\"passed\":" << (after.passed ? "true" : "false")
      << ",\"values\":" << float_array_json(after.values) << "}\n";
  out << "  ],\n";
  out << "  \"retirementEvent\":{\"id\":\"hip-module-retire-1\",\"retired_epoch\":1,\"status\":\"stream_event_proven\",\"api\":\"hipEventRecord+hipStreamSynchronize+hipModuleUnload\"},\n";
  out << "  \"processRestarted\":false,\n";
  out << "  \"sameProcess\":true\n";
  out << "}\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr << "usage: hip_module_runtime_probe <plan.env> <before.hsaco> <after.hsaco> <after-readback.bin> <runtime.json>\n";
    return 64;
  }

  try {
    const Plan plan = load_plan(argv[1]);
    int device_count = 0;
    hip_check(hipGetDeviceCount(&device_count), "hipGetDeviceCount");
    if (device_count < 1) {
      std::cerr << "no HIP devices available\n";
      return 70;
    }
    hip_check(hipSetDevice(0), "hipSetDevice");
    hipDeviceProp_t props{};
    hip_check(hipGetDeviceProperties(&props, 0), "hipGetDeviceProperties");
    const std::string device_name = props.name;
    const std::string device_uuid = std::string("hip-device:") + props.gcnArchName + ":" + std::to_string(props.pciBusID) + ":" + std::to_string(props.pciDeviceID);
    const int process_id = current_pid();
    const std::string session = std::string("hip-module-runtime:pid:") + std::to_string(process_id);

    ModuleEntry before_module = load_module(argv[2], plan);
    DispatchResult before = dispatch_module(before_module, plan, 1, plan.artifact_hash_before);
    ModuleEntry after_module = load_module(argv[3], plan);
    DispatchResult after = dispatch_module(after_module, plan, 2, plan.artifact_hash_after);
    write_binary(argv[4], after.values);
    hip_check(hipDeviceSynchronize(), "hipDeviceSynchronize retirement");
    hip_check(hipModuleUnload(before_module.module), "hipModuleUnload before");
    hip_check(hipModuleUnload(after_module.module), "hipModuleUnload after");
    write_runtime_json(argv[5], plan, before, after, session, device_name, device_uuid, process_id);
    return before.passed && after.passed ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "hip_module_runtime_probe error: " << error.what() << "\n";
    return 1;
  }
}
