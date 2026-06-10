@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-0.74, -0.58),
    vec2f(0.12, 0.66),
    vec2f(0.72, -0.52)
  );
  let xy = positions[vertex_index];
  return vec4f(xy, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(640.0, 360.0);
  return vec4f(0.16 + uv.x * 0.38, 0.30 + uv.y * 0.22, 0.90, 1.0);
}
