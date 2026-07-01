#include <hip/hip_runtime_api.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
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

std::uint64_t monotonic_ns() {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

struct Dim3 {
  unsigned x = 1;
  unsigned y = 1;
  unsigned z = 1;
};

struct BufferPlan {
  std::string name;
  std::string role;
  std::string data_type;
  std::size_t byte_length = 0;
  std::vector<double> values;
};

struct ParamPlan {
  std::string name;
  std::string type;
  std::string value_kind;
  std::string access;
  std::string buffer;
  std::string scalar_type;
  double scalar_value = 0.0;
};

struct Plan {
  std::string kernel_name;
  std::string artifact_hash_before;
  std::string artifact_hash_after;
  std::string dispatch_binding;
  std::string compile_target;
  std::string readback_buffer;
  std::string readback_data_type;
  Dim3 grid_dim;
  Dim3 block_dim;
  unsigned shared_mem_bytes = 0;
  std::size_t element_count = 0;
  double tolerance = 0.00001;
  std::vector<BufferPlan> buffers;
  std::vector<ParamPlan> params;
  std::vector<double> expected_before;
  std::vector<double> expected_after;
};

struct DispatchResult {
  int epoch = 0;
  std::string artifact_hash;
  std::string dispatch_id;
  std::uint64_t module_load_start_ns = 0;
  std::uint64_t module_load_ns = 0;
  std::uint64_t symbol_resolve_ns = 0;
  std::uint64_t epoch_publish_ns = 0;
  std::uint64_t dispatch_start_ns = 0;
  std::uint64_t output_readback_ns = 0;
  float gpu_ms = 0.0f;
  bool passed = false;
  std::vector<unsigned char> readback_bytes;
  std::vector<double> values;
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

void write_binary(const std::string& path, const std::vector<unsigned char>& bytes) {
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("cannot write " + path);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
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

double parse_double(const std::map<std::string, std::string>& plan, const std::string& key, double fallback) {
  const auto found = plan.find(key);
  if (found == plan.end() || found->second.empty()) return fallback;
  return std::stod(found->second);
}

std::vector<double> parse_number_list(const std::string& value) {
  std::vector<double> out;
  std::stringstream stream(value);
  std::string token;
  while (std::getline(stream, token, ',')) {
    const std::string cleaned = trim(token);
    if (!cleaned.empty()) out.push_back(std::stod(cleaned));
  }
  return out;
}

std::vector<std::string> parse_string_list(const std::string& value) {
  std::vector<std::string> out;
  std::stringstream stream(value);
  std::string token;
  while (std::getline(stream, token, ',')) {
    const std::string cleaned = trim(token);
    if (!cleaned.empty()) out.push_back(cleaned);
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

std::string optional_string(const std::map<std::string, std::string>& plan, const std::string& key, const std::string& fallback = "") {
  const auto found = plan.find(key);
  if (found == plan.end() || found->second.empty()) return fallback;
  return found->second;
}

std::size_t data_type_size(const std::string& data_type) {
  if (data_type == "float32") return 4;
  if (data_type == "uint32") return 4;
  if (data_type == "int32") return 4;
  throw std::runtime_error("unsupported data type " + data_type);
}

template <typename T>
void append_scalar_bytes(std::vector<unsigned char>& bytes, T value) {
  const auto* raw = reinterpret_cast<const unsigned char*>(&value);
  bytes.insert(bytes.end(), raw, raw + sizeof(T));
}

std::vector<unsigned char> encode_values(const std::string& data_type, const std::vector<double>& values) {
  std::vector<unsigned char> bytes;
  bytes.reserve(values.size() * data_type_size(data_type));
  for (const double value : values) {
    if (data_type == "float32") {
      append_scalar_bytes(bytes, static_cast<float>(value));
    } else if (data_type == "uint32") {
      if (value < 0 || value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) {
        throw std::runtime_error("uint32 value out of range");
      }
      append_scalar_bytes(bytes, static_cast<std::uint32_t>(value));
    } else if (data_type == "int32") {
      if (value < static_cast<double>(std::numeric_limits<std::int32_t>::min())
          || value > static_cast<double>(std::numeric_limits<std::int32_t>::max())) {
        throw std::runtime_error("int32 value out of range");
      }
      append_scalar_bytes(bytes, static_cast<std::int32_t>(value));
    } else {
      throw std::runtime_error("unsupported data type " + data_type);
    }
  }
  return bytes;
}

template <typename T>
T read_scalar(const std::vector<unsigned char>& bytes, std::size_t offset) {
  T value{};
  std::memcpy(&value, bytes.data() + offset, sizeof(T));
  return value;
}

std::vector<double> decode_values(const std::string& data_type, const std::vector<unsigned char>& bytes) {
  const std::size_t width = data_type_size(data_type);
  if (bytes.size() % width != 0) {
    throw std::runtime_error("readback byte length is not aligned to " + data_type);
  }
  std::vector<double> values;
  values.reserve(bytes.size() / width);
  for (std::size_t offset = 0; offset < bytes.size(); offset += width) {
    if (data_type == "float32") {
      values.push_back(static_cast<double>(read_scalar<float>(bytes, offset)));
    } else if (data_type == "uint32") {
      values.push_back(static_cast<double>(read_scalar<std::uint32_t>(bytes, offset)));
    } else if (data_type == "int32") {
      values.push_back(static_cast<double>(read_scalar<std::int32_t>(bytes, offset)));
    } else {
      throw std::runtime_error("unsupported data type " + data_type);
    }
  }
  return values;
}

std::vector<unsigned char> encode_scalar_value(const std::string& scalar_type, double value) {
  return encode_values(scalar_type, {value});
}

bool is_buffer_param(const ParamPlan& param) {
  return param.value_kind == "global_buffer"
    || param.value_kind == "buffer"
    || param.type.find('*') != std::string::npos;
}

Plan load_plan(const std::string& path) {
  const auto map = read_plan_map(path);
  Plan plan;
  plan.kernel_name = required(map, "kernel_name");
  plan.artifact_hash_before = required(map, "artifact_hash_before");
  plan.artifact_hash_after = required(map, "artifact_hash_after");
  plan.dispatch_binding = required(map, "dispatch_binding");
  plan.compile_target = required(map, "compile_target");
  plan.readback_buffer = required(map, "readback_buffer");
  plan.readback_data_type = required(map, "readback_data_type");
  plan.grid_dim = parse_dim(map, "grid");
  plan.block_dim = parse_dim(map, "block");
  plan.shared_mem_bytes = parse_unsigned(map, "shared_mem_bytes", 0);
  plan.element_count = static_cast<std::size_t>(parse_unsigned(map, "element_count", 0));
  plan.tolerance = parse_double(map, "tolerance", 0.00001);

  const unsigned buffer_count = parse_unsigned(map, "buffer_count", 0);
  if (buffer_count == 0) throw std::runtime_error("plan must declare at least one buffer");
  for (unsigned i = 0; i < buffer_count; ++i) {
    const std::string prefix = "buffer_" + std::to_string(i) + "_";
    BufferPlan buffer;
    buffer.name = required(map, prefix + "name");
    buffer.role = optional_string(map, prefix + "role", "storage");
    buffer.data_type = required(map, prefix + "data_type");
    const auto values_text = optional_string(map, prefix + "values");
    if (!values_text.empty()) buffer.values = parse_number_list(values_text);
    const std::size_t encoded_length = buffer.values.size() * data_type_size(buffer.data_type);
    buffer.byte_length = static_cast<std::size_t>(parse_unsigned(
      map,
      prefix + "byte_length",
      static_cast<unsigned>(encoded_length)));
    if (buffer.byte_length == 0) throw std::runtime_error("buffer " + buffer.name + " byte length must be positive");
    if (!buffer.values.empty() && encoded_length != buffer.byte_length) {
      throw std::runtime_error("buffer " + buffer.name + " values do not match byte length");
    }
    plan.buffers.push_back(buffer);
  }

  const unsigned param_count = parse_unsigned(map, "param_count", 0);
  if (param_count == 0) throw std::runtime_error("plan must declare kernel params");
  for (unsigned i = 0; i < param_count; ++i) {
    const std::string prefix = "param_" + std::to_string(i) + "_";
    ParamPlan param;
    param.name = required(map, prefix + "name");
    param.type = required(map, prefix + "type");
    param.value_kind = required(map, prefix + "value_kind");
    param.access = optional_string(map, prefix + "access", "unknown");
    if (is_buffer_param(param)) {
      param.buffer = required(map, prefix + "buffer");
    } else {
      param.scalar_type = required(map, prefix + "scalar_type");
      param.scalar_value = parse_double(map, prefix + "scalar_value", 0.0);
    }
    plan.params.push_back(param);
  }

  plan.expected_before = parse_number_list(required(map, "expected_before_values"));
  plan.expected_after = parse_number_list(required(map, "expected_after_values"));
  if (plan.element_count == 0) plan.element_count = plan.expected_after.size();
  if (plan.expected_before.size() != plan.element_count
      || plan.expected_after.size() != plan.element_count) {
    throw std::runtime_error("expected vector lengths must match element_count");
  }
  const auto readback = std::find_if(plan.buffers.begin(), plan.buffers.end(), [&](const BufferPlan& buffer) {
    return buffer.name == plan.readback_buffer;
  });
  if (readback == plan.buffers.end()) throw std::runtime_error("readback buffer not declared");
  if (readback->data_type != plan.readback_data_type) throw std::runtime_error("readback data type mismatch");
  if (readback->byte_length != plan.expected_after.size() * data_type_size(plan.readback_data_type)) {
    throw std::runtime_error("readback byte length does not match expected values");
  }
  return plan;
}

bool numeric_vectors_match(const std::vector<double>& actual, const std::vector<double>& expected, double tolerance) {
  if (actual.size() != expected.size()) return false;
  for (std::size_t i = 0; i < actual.size(); ++i) {
    if (std::fabs(actual[i] - expected[i]) > tolerance) return false;
  }
  return true;
}

std::string number_array_json(const std::vector<double>& values) {
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
  std::uint64_t module_load_start_ns = 0;
  std::uint64_t module_load_ns = 0;
  std::uint64_t symbol_resolve_ns = 0;
};

ModuleEntry load_module(const std::string& hsaco_path, const Plan& plan) {
  ModuleEntry entry;
  entry.bytes = read_binary(hsaco_path);
  entry.module_load_start_ns = monotonic_ns();
  hip_check(hipModuleLoadData(&entry.module, entry.bytes.data()), "hipModuleLoadData");
  entry.module_load_ns = monotonic_ns();
  hip_check(hipModuleGetFunction(&entry.function, entry.module, plan.kernel_name.c_str()), "hipModuleGetFunction");
  entry.symbol_resolve_ns = monotonic_ns();
  return entry;
}

struct BufferRuntime {
  BufferPlan plan;
  void* device = nullptr;
  std::vector<unsigned char> host_output;
};

BufferRuntime* find_buffer(std::vector<BufferRuntime>& buffers, const std::string& name) {
  for (auto& buffer : buffers) {
    if (buffer.plan.name == name) return &buffer;
  }
  return nullptr;
}

DispatchResult dispatch_module(const ModuleEntry& entry, const Plan& plan, int epoch, const std::string& artifact_hash) {
  DispatchResult result;
  result.epoch = epoch;
  result.artifact_hash = artifact_hash;
  result.dispatch_id = "hip-module-dispatch-epoch-" + std::to_string(epoch);
  result.module_load_start_ns = entry.module_load_start_ns;
  result.module_load_ns = entry.module_load_ns;
  result.symbol_resolve_ns = entry.symbol_resolve_ns;
  result.epoch_publish_ns = monotonic_ns();

  hipStream_t stream = nullptr;
  hipEvent_t start = nullptr;
  hipEvent_t stop = nullptr;

  std::vector<BufferRuntime> buffers;
  buffers.reserve(plan.buffers.size());
  for (const auto& buffer_plan : plan.buffers) {
    buffers.push_back({buffer_plan, nullptr, std::vector<unsigned char>(buffer_plan.byte_length)});
  }

  hip_check(hipStreamCreate(&stream), "hipStreamCreate");
  hip_check(hipEventCreate(&start), "hipEventCreate start");
  hip_check(hipEventCreate(&stop), "hipEventCreate stop");
  for (auto& buffer : buffers) {
    hip_check(hipMalloc(&buffer.device, buffer.plan.byte_length), ("hipMalloc " + buffer.plan.name).c_str());
    if (!buffer.plan.values.empty()) {
      const auto encoded = encode_values(buffer.plan.data_type, buffer.plan.values);
      hip_check(
        hipMemcpyAsync(buffer.device, encoded.data(), encoded.size(), hipMemcpyHostToDevice, stream),
        ("hipMemcpyAsync " + buffer.plan.name).c_str());
    } else {
      hip_check(hipMemsetAsync(buffer.device, 0, buffer.plan.byte_length, stream), ("hipMemsetAsync " + buffer.plan.name).c_str());
    }
  }

  std::vector<std::vector<unsigned char>> scalar_storage;
  scalar_storage.reserve(plan.params.size());
  std::vector<void*> args;
  args.reserve(plan.params.size());
  for (const auto& param : plan.params) {
    if (is_buffer_param(param)) {
      auto* buffer = find_buffer(buffers, param.buffer);
      if (!buffer) throw std::runtime_error("param " + param.name + " references missing buffer " + param.buffer);
      args.push_back(&buffer->device);
    } else {
      scalar_storage.push_back(encode_scalar_value(param.scalar_type, param.scalar_value));
      args.push_back(scalar_storage.back().data());
    }
  }

  hip_check(hipEventRecord(start, stream), "hipEventRecord start");
  result.dispatch_start_ns = monotonic_ns();
  hip_check(
    hipModuleLaunchKernel(
      entry.function,
      plan.grid_dim.x, plan.grid_dim.y, plan.grid_dim.z,
      plan.block_dim.x, plan.block_dim.y, plan.block_dim.z,
      plan.shared_mem_bytes,
      stream,
      args.data(),
      nullptr),
    "hipModuleLaunchKernel");
  hip_check(hipEventRecord(stop, stream), "hipEventRecord stop");
  auto* readback = find_buffer(buffers, plan.readback_buffer);
  if (!readback) throw std::runtime_error("missing readback buffer " + plan.readback_buffer);
  hip_check(
    hipMemcpyAsync(readback->host_output.data(), readback->device, readback->host_output.size(), hipMemcpyDeviceToHost, stream),
    "hipMemcpyAsync readback");
  hip_check(hipStreamSynchronize(stream), "hipStreamSynchronize");
  result.output_readback_ns = monotonic_ns();
  hip_check(hipEventElapsedTime(&result.gpu_ms, start, stop), "hipEventElapsedTime");

  result.readback_bytes = readback->host_output;
  result.values = decode_values(plan.readback_data_type, result.readback_bytes);
  result.passed = numeric_vectors_match(
    result.values,
    epoch == 1 ? plan.expected_before : plan.expected_after,
    plan.tolerance);

  for (auto& buffer : buffers) {
    hip_check(hipFree(buffer.device), ("hipFree " + buffer.plan.name).c_str());
  }
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
  const std::string& device_arch,
  int process_id) {
  std::ofstream out(path);
  if (!out) throw std::runtime_error("cannot write runtime json " + path);
  out << "{\n";
  out << "  \"schemaVersion\":\"synthi.gpu.hmr.hip_module_runtime_trace.v1\",\n";
  out << "  \"runtimeSessionId\":" << json_string(session) << ",\n";
  out << "  \"processId\":" << json_string(std::to_string(process_id)) << ",\n";
  out << "  \"device\":{\"backend\":\"hip\",\"name\":" << json_string(device_name)
      << ",\"device_uuid\":" << json_string(device_uuid)
      << ",\"gpu_arch\":" << json_string(device_arch)
      << ",\"gcn_arch_name\":" << json_string(device_arch) << ",\"compile_target\":"
      << json_string(plan.compile_target) << "},\n";
  out << "  \"loaderEvents\":[\n";
  out << "    {\"id\":\"hip-module-loader-1\",\"artifact_hash\":" << json_string(plan.artifact_hash_before)
      << ",\"epoch\":1,\"api\":\"hipModuleLoadData\",\"start_timestamp_monotonic_ns\":" << before.module_load_start_ns
      << ",\"timestamp_monotonic_ns\":" << before.module_load_ns << "},\n";
  out << "    {\"id\":\"hip-module-loader-2\",\"artifact_hash\":" << json_string(plan.artifact_hash_after)
      << ",\"epoch\":2,\"api\":\"hipModuleLoadData\",\"start_timestamp_monotonic_ns\":" << after.module_load_start_ns
      << ",\"timestamp_monotonic_ns\":" << after.module_load_ns << "}\n";
  out << "  ],\n";
  out << "  \"symbolEvents\":[\n";
  out << "    {\"epoch\":1,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name)
      << ",\"timestamp_monotonic_ns\":" << before.symbol_resolve_ns << "},\n";
  out << "    {\"epoch\":2,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name)
      << ",\"timestamp_monotonic_ns\":" << after.symbol_resolve_ns << "}\n";
  out << "  ],\n";
  out << "  \"epochEvents\":[\n";
  out << "    {\"id\":\"hip-module-publish-1\",\"epoch\":1,\"artifact_hash\":" << json_string(plan.artifact_hash_before)
      << ",\"timestamp_monotonic_ns\":" << before.epoch_publish_ns << "},\n";
  out << "    {\"id\":\"hip-module-publish-2\",\"epoch\":2,\"artifact_hash\":" << json_string(plan.artifact_hash_after)
      << ",\"timestamp_monotonic_ns\":" << after.epoch_publish_ns << "}\n";
  out << "  ],\n";
  out << "  \"dispatchEvents\":[\n";
  out << "    {\"id\":" << json_string(before.dispatch_id) << ",\"epoch\":1,\"artifact_hash\":"
      << json_string(before.artifact_hash) << ",\"launch_api\":\"hipModuleLaunchKernel\",\"grid_dim\":"
      << dim_json(plan.grid_dim) << ",\"block_dim\":" << dim_json(plan.block_dim)
      << ",\"shared_mem_bytes\":" << plan.shared_mem_bytes << ",\"stream\":\"hipStreamCreate\",\"gpu_ms\":"
      << before.gpu_ms << ",\"timestamp_monotonic_ns\":" << before.dispatch_start_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"passed\":" << (before.passed ? "true" : "false") << "},\n";
  out << "    {\"id\":" << json_string(after.dispatch_id) << ",\"epoch\":2,\"artifact_hash\":"
      << json_string(after.artifact_hash) << ",\"launch_api\":\"hipModuleLaunchKernel\",\"grid_dim\":"
      << dim_json(plan.grid_dim) << ",\"block_dim\":" << dim_json(plan.block_dim)
      << ",\"shared_mem_bytes\":" << plan.shared_mem_bytes << ",\"stream\":\"hipStreamCreate\",\"gpu_ms\":"
      << after.gpu_ms << ",\"timestamp_monotonic_ns\":" << after.dispatch_start_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"passed\":" << (after.passed ? "true" : "false") << "}\n";
  out << "  ],\n";
  out << "  \"outputEvents\":[\n";
  out << "    {\"id\":\"hip-module-output-1\",\"after_dispatch_id\":" << json_string(before.dispatch_id)
      << ",\"epoch\":1,\"artifact_hash\":" << json_string(before.artifact_hash)
      << ",\"passed\":" << (before.passed ? "true" : "false")
      << ",\"timestamp_monotonic_ns\":" << before.output_readback_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"values\":" << number_array_json(before.values) << "},\n";
  out << "    {\"id\":\"hip-module-output-2\",\"after_dispatch_id\":" << json_string(after.dispatch_id)
      << ",\"epoch\":2,\"artifact_hash\":" << json_string(after.artifact_hash)
      << ",\"passed\":" << (after.passed ? "true" : "false")
      << ",\"timestamp_monotonic_ns\":" << after.output_readback_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"values\":" << number_array_json(after.values) << "}\n";
  out << "  ],\n";
  out << "  \"retirementEvent\":{\"id\":\"hip-module-retire-1\",\"retired_epoch\":1,\"status\":\"stream_event_proven\",\"api\":\"hipEventRecord+hipStreamSynchronize+hipModuleUnload\",\"timestamp_monotonic_ns\":" << monotonic_ns() << "},\n";
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
    const std::string device_arch = props.gcnArchName;
    const std::string device_uuid = std::string("hip-device:") + props.gcnArchName + ":" + std::to_string(props.pciBusID) + ":" + std::to_string(props.pciDeviceID);
    const int process_id = current_pid();
    const std::string session = std::string("hip-module-runtime:pid:") + std::to_string(process_id);

    ModuleEntry before_module = load_module(argv[2], plan);
    DispatchResult before = dispatch_module(before_module, plan, 1, plan.artifact_hash_before);
    ModuleEntry after_module = load_module(argv[3], plan);
    DispatchResult after = dispatch_module(after_module, plan, 2, plan.artifact_hash_after);
    write_binary(argv[4], after.readback_bytes);
    hip_check(hipDeviceSynchronize(), "hipDeviceSynchronize retirement");
    hip_check(hipModuleUnload(before_module.module), "hipModuleUnload before");
    hip_check(hipModuleUnload(after_module.module), "hipModuleUnload after");
    write_runtime_json(argv[5], plan, before, after, session, device_name, device_uuid, device_arch, process_id);
    return before.passed && after.passed ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "hip_module_runtime_probe error: " << error.what() << "\n";
    return 1;
  }
}
