@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-0.58, 0.50),
    vec2f(0.82, 0.42),
    vec2f(0.02, -0.70)
  );
  let xy = positions[vertex_index];
  return vec4f(xy, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(640.0, 360.0);
  return vec4f(0.88 - uv.y * 0.24, 0.62 + uv.x * 0.20, 0.18 + uv.y * 0.18, 1.0);
}
