struct Values {
  data: array<f32>,
};

@group(0) @binding(0) var<storage, read> input_values: Values;
@group(0) @binding(1) var<storage, read_write> output_values: Values;

@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= arrayLength(&input_values.data)) {
    return;
  }
  let base = input_values.data[i];
  output_values.data[i] = base * 4.0 - f32(i) * 0.5;
}
