struct Params {
  tint: vec4f,
  offset: vec4f,
};

struct VertexIn {
  @location(0) position: vec2f,
  @location(1) shade: vec2f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) shade: vec2f,
};

@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let bend = vec2f(input.shade.y * 0.08, -input.shade.x * 0.05);
  out.position = vec4f(input.position + params.offset.xy + bend, 0.0, 1.0);
  out.shade = input.shade;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let base = params.tint.rgb;
  let shade = vec3f(0.16 + input.shade.y * 0.52, 0.18 + input.shade.x * 0.26, 0.72);
  return vec4f(base * 0.42 + shade * 0.58, 1.0);
}
