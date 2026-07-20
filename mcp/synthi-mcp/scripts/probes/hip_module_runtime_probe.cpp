#include <hip/hip_runtime_api.h>

#include <algorithm>
#include <array>
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
#include <utility>
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
  std::string initial_bytes_hash;
};

struct ParamPlan {
  std::string name;
  std::string type;
  std::string value_kind;
  std::string access;
  std::string buffer;
  std::string scalar_type;
  double scalar_value = 0.0;
  std::string scalar_value_json;
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
  std::string plan_hash;
};

struct ResourceObservation {
  std::string name;
  std::string role;
  std::string data_type;
  std::size_t byte_length = 0;
  std::vector<unsigned char> initial_bytes;
  std::string initial_bytes_hash;
  std::string resource_id;
  std::string device_pointer;
};

struct ParameterObservation {
  std::size_t index = 0;
  std::string name;
  std::string kind;
  std::string buffer;
  std::string data_type;
  std::string value_json;
  std::string argument_address;
  std::string resource_id;
  std::string device_pointer;
  std::vector<unsigned char> encoded_bytes;
  std::string encoded_bytes_hash;
};

struct DispatchResult {
  int epoch = 0;
  std::string artifact_hash;
  std::string dispatch_id;
  std::string output_event_id;
  std::string loaded_bytes_hash;
  std::size_t loaded_byte_length = 0;
  std::string requested_symbol;
  std::string resolved_symbol;
  std::string function_id;
  std::string function_address;
  std::string stream_id;
  std::string argument_array_address;
  std::string resource_trace_hash;
  std::string parameter_trace_hash;
  std::string observed_readback_hash;
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
  std::vector<ResourceObservation> resources;
  std::vector<ParameterObservation> parameters;
};

std::uint32_t rotate_right(std::uint32_t value, unsigned bits) {
  return (value >> bits) | (value << (32U - bits));
}

std::string sha256_bytes(const unsigned char* data, std::size_t size) {
  static constexpr std::array<std::uint32_t, 64> constants = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  std::vector<unsigned char> padded;
  padded.reserve(size + 72);
  if (size > 0) padded.insert(padded.end(), data, data + size);
  padded.push_back(0x80U);
  while (padded.size() % 64U != 56U) padded.push_back(0U);
  const std::uint64_t bit_length = static_cast<std::uint64_t>(size) * 8U;
  for (int shift = 56; shift >= 0; shift -= 8) {
    padded.push_back(static_cast<unsigned char>((bit_length >> shift) & 0xffU));
  }

  std::array<std::uint32_t, 8> state = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  for (std::size_t offset = 0; offset < padded.size(); offset += 64U) {
    std::array<std::uint32_t, 64> words{};
    for (std::size_t i = 0; i < 16; ++i) {
      const std::size_t at = offset + i * 4U;
      words[i] = (static_cast<std::uint32_t>(padded[at]) << 24U)
        | (static_cast<std::uint32_t>(padded[at + 1]) << 16U)
        | (static_cast<std::uint32_t>(padded[at + 2]) << 8U)
        | static_cast<std::uint32_t>(padded[at + 3]);
    }
    for (std::size_t i = 16; i < words.size(); ++i) {
      const std::uint32_t s0 = rotate_right(words[i - 15], 7U)
        ^ rotate_right(words[i - 15], 18U) ^ (words[i - 15] >> 3U);
      const std::uint32_t s1 = rotate_right(words[i - 2], 17U)
        ^ rotate_right(words[i - 2], 19U) ^ (words[i - 2] >> 10U);
      words[i] = words[i - 16] + s0 + words[i - 7] + s1;
    }
    std::uint32_t a = state[0];
    std::uint32_t b = state[1];
    std::uint32_t c = state[2];
    std::uint32_t d = state[3];
    std::uint32_t e = state[4];
    std::uint32_t f = state[5];
    std::uint32_t g = state[6];
    std::uint32_t h = state[7];
    for (std::size_t i = 0; i < words.size(); ++i) {
      const std::uint32_t sum1 = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^ rotate_right(e, 25U);
      const std::uint32_t choice = (e & f) ^ ((~e) & g);
      const std::uint32_t temp1 = h + sum1 + choice + constants[i] + words[i];
      const std::uint32_t sum0 = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^ rotate_right(a, 22U);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temp2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  std::ostringstream out;
  out << "sha256:" << std::hex << std::setfill('0');
  for (const auto word : state) out << std::setw(8) << word;
  return out.str();
}

template <typename Byte>
std::string sha256_bytes(const std::vector<Byte>& bytes) {
  return sha256_bytes(
    bytes.empty() ? nullptr : reinterpret_cast<const unsigned char*>(bytes.data()),
    bytes.size());
}

std::string sha256_text(const std::string& text) {
  return sha256_bytes(reinterpret_cast<const unsigned char*>(text.data()), text.size());
}

template <typename Pointer>
std::string pointer_string(Pointer pointer) {
  std::ostringstream out;
  out << "0x" << std::hex << reinterpret_cast<std::uintptr_t>(pointer);
  return out.str();
}

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
  if (size < 0) throw std::runtime_error("cannot determine byte length of " + path);
  in.seekg(0, std::ios::beg);
  std::vector<char> bytes(static_cast<std::size_t>(size));
  if (size > 0) in.read(bytes.data(), size);
  if (!in) throw std::runtime_error("cannot read " + path);
  return bytes;
}

void write_binary(const std::string& path, const std::vector<unsigned char>& bytes) {
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("cannot write " + path);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  out.flush();
  if (!out) throw std::runtime_error("cannot flush " + path);
}

std::map<std::string, std::string> read_plan_map(const std::vector<char>& bytes) {
  std::istringstream in(std::string(bytes.begin(), bytes.end()));
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
  std::size_t consumed = 0;
  const double value = std::stod(found->second, &consumed);
  if (consumed != found->second.size() || !std::isfinite(value)) {
    throw std::runtime_error("plan field " + key + " must be finite numeric text");
  }
  return value;
}

std::vector<double> parse_number_list(const std::string& value) {
  std::vector<double> out;
  std::stringstream stream(value);
  std::string token;
  while (std::getline(stream, token, ',')) {
    const std::string cleaned = trim(token);
    if (!cleaned.empty()) {
      std::size_t consumed = 0;
      const double parsed = std::stod(cleaned, &consumed);
      if (consumed != cleaned.size() || !std::isfinite(parsed)) {
        throw std::runtime_error("numeric list contains a non-finite or invalid value");
      }
      out.push_back(parsed);
    }
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
    if (!std::isfinite(value)) throw std::runtime_error("cannot encode a non-finite value");
    if (data_type == "float32") {
      const float encoded = static_cast<float>(value);
      if (!std::isfinite(encoded)) throw std::runtime_error("float32 value is not finite");
      append_scalar_bytes(bytes, encoded);
    } else if (data_type == "uint32") {
      if (std::trunc(value) != value || value < 0
          || value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) {
        throw std::runtime_error("uint32 value out of range");
      }
      append_scalar_bytes(bytes, static_cast<std::uint32_t>(value));
    } else if (data_type == "int32") {
      if (std::trunc(value) != value
          || value < static_cast<double>(std::numeric_limits<std::int32_t>::min())
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

Plan load_plan(const std::vector<char>& plan_bytes) {
  const auto map = read_plan_map(plan_bytes);
  Plan plan;
  plan.plan_hash = sha256_bytes(plan_bytes);
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
  if (plan.tolerance < 0) throw std::runtime_error("tolerance must be finite and non-negative");

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
    buffer.initial_bytes_hash = required(map, prefix + "initial_bytes_hash");
    const std::size_t encoded_length = buffer.values.size() * data_type_size(buffer.data_type);
    buffer.byte_length = static_cast<std::size_t>(parse_unsigned(
      map,
      prefix + "byte_length",
      static_cast<unsigned>(encoded_length)));
    if (buffer.byte_length == 0) throw std::runtime_error("buffer " + buffer.name + " byte length must be positive");
    if (!buffer.values.empty() && encoded_length != buffer.byte_length) {
      throw std::runtime_error("buffer " + buffer.name + " values do not match byte length");
    }
    const std::vector<unsigned char> initial_bytes = buffer.values.empty()
      ? std::vector<unsigned char>(buffer.byte_length, 0U)
      : encode_values(buffer.data_type, buffer.values);
    if (sha256_bytes(initial_bytes) != buffer.initial_bytes_hash) {
      throw std::runtime_error("buffer " + buffer.name + " initial bytes hash mismatch");
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
      param.scalar_value_json = required(map, prefix + "scalar_value");
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
  if (!std::isfinite(tolerance) || tolerance < 0 || actual.size() != expected.size()) return false;
  for (std::size_t i = 0; i < actual.size(); ++i) {
    if (!std::isfinite(actual[i]) || !std::isfinite(expected[i])) return false;
    if (std::fabs(actual[i] - expected[i]) > tolerance) return false;
  }
  return true;
}

std::string number_array_json(const std::vector<double>& values) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ",";
    if (!std::isfinite(values[i])) throw std::runtime_error("cannot serialize a non-finite value");
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

std::string byte_array_json(const std::vector<unsigned char>& bytes) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    if (i) out << ",";
    out << static_cast<unsigned>(bytes[i]);
  }
  out << "]";
  return out.str();
}

std::string resource_json(const ResourceObservation& resource) {
  std::ostringstream out;
  out << "{\"byteLength\":" << resource.byte_length
      << ",\"dataType\":" << json_string(resource.data_type)
      << ",\"devicePointer\":" << json_string(resource.device_pointer)
      << ",\"initialBytes\":" << byte_array_json(resource.initial_bytes)
      << ",\"initialBytesHash\":" << json_string(resource.initial_bytes_hash)
      << ",\"name\":" << json_string(resource.name)
      << ",\"resourceId\":" << json_string(resource.resource_id)
      << ",\"role\":" << json_string(resource.role) << "}";
  return out.str();
}

std::string parameter_json(const ParameterObservation& parameter) {
  std::ostringstream out;
  out << "{\"argumentAddress\":" << json_string(parameter.argument_address);
  if (parameter.kind == "buffer") {
    out << ",\"buffer\":" << json_string(parameter.buffer)
        << ",\"dataType\":" << json_string(parameter.data_type)
        << ",\"devicePointer\":" << json_string(parameter.device_pointer)
        << ",\"index\":" << parameter.index
        << ",\"kind\":\"buffer\""
        << ",\"name\":" << json_string(parameter.name)
        << ",\"resourceId\":" << json_string(parameter.resource_id);
  } else {
    out << ",\"dataType\":" << json_string(parameter.data_type)
        << ",\"encodedBytes\":" << byte_array_json(parameter.encoded_bytes)
        << ",\"encodedBytesHash\":" << json_string(parameter.encoded_bytes_hash)
        << ",\"index\":" << parameter.index
        << ",\"kind\":\"scalar\""
        << ",\"name\":" << json_string(parameter.name)
        << ",\"value\":" << parameter.value_json;
  }
  out << "}";
  return out.str();
}

template <typename Observation, typename Serialize>
std::string observation_array_json(const std::vector<Observation>& observations, Serialize serialize) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < observations.size(); ++i) {
    if (i) out << ",";
    out << serialize(observations[i]);
  }
  out << "]";
  return out.str();
}

std::string resources_json(const std::vector<ResourceObservation>& resources) {
  return observation_array_json(resources, resource_json);
}

std::string parameters_json(const std::vector<ParameterObservation>& parameters) {
  return observation_array_json(parameters, parameter_json);
}

std::string resource_trace_hash(
  const std::string& plan_hash,
  const std::vector<ResourceObservation>& resources,
  const std::vector<ParameterObservation>& parameters) {
  const std::string material = std::string("{\"parameters\":") + parameters_json(parameters)
    + ",\"planHash\":" + json_string(plan_hash)
    + ",\"resources\":" + resources_json(resources)
    + ",\"schemaVersion\":\"synthi.gpu_hmr.hip_runtime_resource_trace.v1\"}";
  return sha256_text(material);
}

struct ModuleEntry {
  hipModule_t module = nullptr;
  hipFunction_t function = nullptr;
  std::vector<char> bytes;
  std::string loaded_bytes_hash;
  std::string requested_symbol;
  std::string resolved_symbol;
  std::string function_id;
  std::string function_address;
  std::uint64_t module_load_start_ns = 0;
  std::uint64_t module_load_ns = 0;
  std::uint64_t symbol_resolve_ns = 0;
};

ModuleEntry load_module(
  std::vector<char> verified_bytes,
  const std::string& expected_hash,
  const Plan& plan) {
  ModuleEntry entry;
  entry.bytes = std::move(verified_bytes);
  entry.loaded_bytes_hash = sha256_bytes(entry.bytes);
  if (entry.bytes.empty()) throw std::runtime_error("verified HSACO bytes are empty");
  if (entry.loaded_bytes_hash != expected_hash) {
    throw std::runtime_error("HSACO bytes do not match the verified artifact hash");
  }
  entry.requested_symbol = plan.kernel_name;
  entry.module_load_start_ns = monotonic_ns();
  hip_check(hipModuleLoadData(&entry.module, entry.bytes.data()), "hipModuleLoadData");
  entry.module_load_ns = monotonic_ns();
  hip_check(
    hipModuleGetFunction(&entry.function, entry.module, entry.requested_symbol.c_str()),
    "hipModuleGetFunction");
  entry.symbol_resolve_ns = monotonic_ns();
  if (entry.function == nullptr) throw std::runtime_error("hipModuleGetFunction returned a null function");
  entry.resolved_symbol = entry.requested_symbol;
  entry.function_address = pointer_string(entry.function);
  const std::string function_material = std::string("{\"loadedBytesHash\":")
    + json_string(entry.loaded_bytes_hash)
    + ",\"requestedSymbol\":" + json_string(entry.requested_symbol)
    + ",\"resolvedFunctionAddress\":" + json_string(entry.function_address)
    + ",\"resolvedSymbol\":" + json_string(entry.resolved_symbol) + "}";
  entry.function_id = "hip-function:" + sha256_text(function_material);
  return entry;
}

struct BufferRuntime {
  BufferPlan plan;
  void* device = nullptr;
  std::vector<unsigned char> initial_bytes;
  std::string resource_id;
  std::string device_pointer;
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
  result.output_event_id = "hip-module-output-" + std::to_string(epoch);
  result.loaded_bytes_hash = entry.loaded_bytes_hash;
  result.loaded_byte_length = entry.bytes.size();
  result.requested_symbol = entry.requested_symbol;
  result.resolved_symbol = entry.resolved_symbol;
  result.function_id = entry.function_id;
  result.function_address = entry.function_address;
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
    const std::vector<unsigned char> initial_bytes = buffer_plan.values.empty()
      ? std::vector<unsigned char>(buffer_plan.byte_length, 0U)
      : encode_values(buffer_plan.data_type, buffer_plan.values);
    buffers.push_back({
      buffer_plan,
      nullptr,
      initial_bytes,
      "",
      "",
      std::vector<unsigned char>(buffer_plan.byte_length),
    });
  }

  hip_check(hipStreamCreate(&stream), "hipStreamCreate");
  result.stream_id = pointer_string(stream);
  hip_check(hipEventCreate(&start), "hipEventCreate start");
  hip_check(hipEventCreate(&stop), "hipEventCreate stop");
  for (auto& buffer : buffers) {
    hip_check(hipMalloc(&buffer.device, buffer.plan.byte_length), ("hipMalloc " + buffer.plan.name).c_str());
    buffer.device_pointer = pointer_string(buffer.device);
    const std::string resource_identity_material = std::string("{\"artifactHash\":")
      + json_string(artifact_hash)
      + ",\"byteLength\":" + std::to_string(buffer.plan.byte_length)
      + ",\"devicePointer\":" + json_string(buffer.device_pointer)
      + ",\"epoch\":" + std::to_string(epoch)
      + ",\"name\":" + json_string(buffer.plan.name) + "}";
    buffer.resource_id = "hip-resource:" + sha256_text(resource_identity_material);
    hip_check(
      hipMemcpyAsync(
        buffer.device,
        buffer.initial_bytes.data(),
        buffer.initial_bytes.size(),
        hipMemcpyHostToDevice,
        stream),
      ("hipMemcpyAsync " + buffer.plan.name).c_str());
    result.resources.push_back({
      buffer.plan.name,
      buffer.plan.role,
      buffer.plan.data_type,
      buffer.plan.byte_length,
      buffer.initial_bytes,
      sha256_bytes(buffer.initial_bytes),
      buffer.resource_id,
      buffer.device_pointer,
    });
  }

  std::vector<std::vector<unsigned char>> scalar_storage;
  scalar_storage.reserve(plan.params.size());
  std::vector<void*> args;
  args.reserve(plan.params.size());
  for (std::size_t index = 0; index < plan.params.size(); ++index) {
    const auto& param = plan.params[index];
    if (is_buffer_param(param)) {
      auto* buffer = find_buffer(buffers, param.buffer);
      if (!buffer) throw std::runtime_error("param " + param.name + " references missing buffer " + param.buffer);
      args.push_back(&buffer->device);
      result.parameters.push_back({
        index,
        param.name,
        "buffer",
        param.buffer,
        buffer->plan.data_type,
        "",
        pointer_string(args.back()),
        buffer->resource_id,
        buffer->device_pointer,
        {},
        "",
      });
    } else {
      scalar_storage.push_back(encode_scalar_value(param.scalar_type, param.scalar_value));
      args.push_back(scalar_storage.back().data());
      result.parameters.push_back({
        index,
        param.name,
        "scalar",
        "",
        param.scalar_type,
        param.scalar_value_json,
        pointer_string(args.back()),
        "",
        "",
        scalar_storage.back(),
        sha256_bytes(scalar_storage.back()),
      });
    }
  }
  result.parameter_trace_hash = sha256_text(parameters_json(result.parameters));
  result.resource_trace_hash = resource_trace_hash(plan.plan_hash, result.resources, result.parameters);
  result.argument_array_address = pointer_string(args.data());

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
  result.observed_readback_hash = sha256_bytes(result.readback_bytes);
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
  if (!std::isfinite(before.gpu_ms) || !std::isfinite(after.gpu_ms)) {
    throw std::runtime_error("HIP dispatch timing is not finite");
  }
  const auto output_resource = std::find_if(
    after.resources.begin(),
    after.resources.end(),
    [&](const ResourceObservation& resource) { return resource.name == plan.readback_buffer; });
  if (output_resource == after.resources.end()) {
    throw std::runtime_error("readback runtime resource observation is missing");
  }
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
      << ",\"loaded_bytes_hash\":" << json_string(before.loaded_bytes_hash)
      << ",\"loaded_byte_length\":" << before.loaded_byte_length
      << ",\"epoch\":1,\"api\":\"hipModuleLoadData\",\"start_timestamp_monotonic_ns\":" << before.module_load_start_ns
      << ",\"timestamp_monotonic_ns\":" << before.module_load_ns << "},\n";
  out << "    {\"id\":\"hip-module-loader-2\",\"artifact_hash\":" << json_string(plan.artifact_hash_after)
      << ",\"loaded_bytes_hash\":" << json_string(after.loaded_bytes_hash)
      << ",\"loaded_byte_length\":" << after.loaded_byte_length
      << ",\"epoch\":2,\"api\":\"hipModuleLoadData\",\"start_timestamp_monotonic_ns\":" << after.module_load_start_ns
      << ",\"timestamp_monotonic_ns\":" << after.module_load_ns << "}\n";
  out << "  ],\n";
  out << "  \"symbolEvents\":[\n";
  out << "    {\"id\":\"hip-module-symbol-1\",\"epoch\":1,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name)
      << ",\"requested_symbol\":" << json_string(before.requested_symbol)
      << ",\"resolved_symbol\":" << json_string(before.resolved_symbol)
      << ",\"function_id\":" << json_string(before.function_id)
      << ",\"resolved_function_address\":" << json_string(before.function_address)
      << ",\"timestamp_monotonic_ns\":" << before.symbol_resolve_ns << "},\n";
  out << "    {\"id\":\"hip-module-symbol-2\",\"epoch\":2,\"api\":\"hipModuleGetFunction\",\"kernel_name\":" << json_string(plan.kernel_name)
      << ",\"requested_symbol\":" << json_string(after.requested_symbol)
      << ",\"resolved_symbol\":" << json_string(after.resolved_symbol)
      << ",\"function_id\":" << json_string(after.function_id)
      << ",\"resolved_function_address\":" << json_string(after.function_address)
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
      << ",\"stream_id\":" << json_string(before.stream_id)
      << ",\"kernel_argument_array_address\":" << json_string(before.argument_array_address)
      << ",\"kernel_name\":" << json_string(before.requested_symbol)
      << ",\"resolved_symbol\":" << json_string(before.resolved_symbol)
      << ",\"function_id\":" << json_string(before.function_id)
      << ",\"resolved_function_address\":" << json_string(before.function_address)
      << ",\"resource_trace_hash\":" << json_string(before.resource_trace_hash)
      << ",\"parameter_trace_hash\":" << json_string(before.parameter_trace_hash)
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"passed\":" << (before.passed ? "true" : "false") << "},\n";
  out << "    {\"id\":" << json_string(after.dispatch_id) << ",\"epoch\":2,\"artifact_hash\":"
      << json_string(after.artifact_hash) << ",\"launch_api\":\"hipModuleLaunchKernel\",\"grid_dim\":"
      << dim_json(plan.grid_dim) << ",\"block_dim\":" << dim_json(plan.block_dim)
      << ",\"shared_mem_bytes\":" << plan.shared_mem_bytes << ",\"stream\":\"hipStreamCreate\",\"gpu_ms\":"
      << after.gpu_ms << ",\"timestamp_monotonic_ns\":" << after.dispatch_start_ns
      << ",\"stream_id\":" << json_string(after.stream_id)
      << ",\"kernel_argument_array_address\":" << json_string(after.argument_array_address)
      << ",\"kernel_name\":" << json_string(after.requested_symbol)
      << ",\"resolved_symbol\":" << json_string(after.resolved_symbol)
      << ",\"function_id\":" << json_string(after.function_id)
      << ",\"resolved_function_address\":" << json_string(after.function_address)
      << ",\"resource_trace_hash\":" << json_string(after.resource_trace_hash)
      << ",\"parameter_trace_hash\":" << json_string(after.parameter_trace_hash)
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"passed\":" << (after.passed ? "true" : "false") << "}\n";
  out << "  ],\n";
  out << "  \"outputEvents\":[\n";
  out << "    {\"id\":" << json_string(before.output_event_id) << ",\"after_dispatch_id\":" << json_string(before.dispatch_id)
      << ",\"epoch\":1,\"artifact_hash\":" << json_string(before.artifact_hash)
      << ",\"passed\":" << (before.passed ? "true" : "false")
      << ",\"timestamp_monotonic_ns\":" << before.output_readback_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"readback_hash\":" << json_string(before.observed_readback_hash)
      << ",\"readback_byte_length\":" << before.readback_bytes.size()
      << ",\"values\":" << number_array_json(before.values) << "},\n";
  out << "    {\"id\":" << json_string(after.output_event_id) << ",\"after_dispatch_id\":" << json_string(after.dispatch_id)
      << ",\"epoch\":2,\"artifact_hash\":" << json_string(after.artifact_hash)
      << ",\"passed\":" << (after.passed ? "true" : "false")
      << ",\"timestamp_monotonic_ns\":" << after.output_readback_ns
      << ",\"output_target_id\":" << json_string(plan.readback_buffer)
      << ",\"readback_hash\":" << json_string(after.observed_readback_hash)
      << ",\"readback_byte_length\":" << after.readback_bytes.size()
      << ",\"values\":" << number_array_json(after.values) << "}\n";
  out << "  ],\n";
  out << "  \"probeInvocation\":{"
      << "\"schemaVersion\":\"synthi.gpu_hmr.hip_runtime_invocation_evidence.v1\""
      << ",\"producer\":\"native_hip_module_runtime_probe\""
      << ",\"runtimeSessionId\":" << json_string(session)
      << ",\"planHash\":" << json_string(plan.plan_hash)
      << ",\"resourceTraceHash\":" << json_string(after.resource_trace_hash)
      << ",\"parameterTraceHash\":" << json_string(after.parameter_trace_hash)
      << ",\"resources\":" << resources_json(after.resources)
      << ",\"parameters\":" << parameters_json(after.parameters)
      << ",\"loaderEventId\":\"hip-module-loader-2\""
      << ",\"symbolEventId\":\"hip-module-symbol-2\""
      << ",\"dispatchId\":" << json_string(after.dispatch_id)
      << ",\"artifactHash\":" << json_string(after.artifact_hash)
      << ",\"loadedBytesHash\":" << json_string(after.loaded_bytes_hash)
      << ",\"loadedByteLength\":" << after.loaded_byte_length
      << ",\"kernelIdentity\":" << json_string(after.requested_symbol)
      << ",\"requestedSymbol\":" << json_string(after.requested_symbol)
      << ",\"resolvedSymbol\":" << json_string(after.resolved_symbol)
      << ",\"functionId\":" << json_string(after.function_id)
      << ",\"resolvedFunctionAddress\":" << json_string(after.function_address)
      << ",\"dispatchBinding\":" << json_string(plan.dispatch_binding)
      << ",\"streamId\":" << json_string(after.stream_id)
      << ",\"kernelArgumentArrayAddress\":" << json_string(after.argument_array_address)
      << ",\"outputEventId\":" << json_string(after.output_event_id)
      << ",\"outputResourceId\":" << json_string(plan.readback_buffer)
      << ",\"outputRuntimeResourceId\":" << json_string(output_resource->resource_id)
      << ",\"outputDevicePointer\":" << json_string(output_resource->device_pointer)
      << ",\"observedReadbackHash\":" << json_string(after.observed_readback_hash)
      << ",\"readbackByteLength\":" << after.readback_bytes.size() << "},\n";
  out << "  \"retirementEvent\":{\"id\":\"hip-module-retire-1\",\"retired_epoch\":1,\"status\":\"stream_event_proven\",\"api\":\"hipEventRecord+hipStreamSynchronize+hipModuleUnload\",\"timestamp_monotonic_ns\":" << monotonic_ns() << "},\n";
  out << "  \"processRestarted\":false,\n";
  out << "  \"sameProcess\":true\n";
  out << "}\n";
  out.flush();
  if (!out) throw std::runtime_error("cannot flush runtime json " + path);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr << "usage: hip_module_runtime_probe <plan.env> <before.hsaco> <after.hsaco> <after-readback.bin> <runtime.json>\n";
    return 64;
  }

  try {
    const std::vector<char> plan_bytes = read_binary(argv[1]);
    const Plan plan = load_plan(plan_bytes);
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
    const std::string session = std::string("hip-module-runtime:pid:") + std::to_string(process_id)
      + ":start-ns:" + std::to_string(monotonic_ns());

    ModuleEntry before_module = load_module(read_binary(argv[2]), plan.artifact_hash_before, plan);
    DispatchResult before = dispatch_module(before_module, plan, 1, plan.artifact_hash_before);
    ModuleEntry after_module = load_module(read_binary(argv[3]), plan.artifact_hash_after, plan);
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
