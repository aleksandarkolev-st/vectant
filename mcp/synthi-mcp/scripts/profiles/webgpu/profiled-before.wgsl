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
  out.position = vec4f(input.position + params.offset.xy, 0.0, 1.0);
  out.shade = input.shade;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let base = params.tint.rgb;
  let shade = vec3f(input.shade.x * 0.20, input.shade.y * 0.30, 0.12);
  return vec4f(base * 0.56 + shade, 1.0);
}
