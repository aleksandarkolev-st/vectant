@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-0.84, 0.22),
    vec2f(0.54, 0.76),
    vec2f(0.38, -0.78)
  );
  let xy = positions[vertex_index];
  return vec4f(xy, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(640.0, 360.0);
  return vec4f(0.22 + uv.y * 0.34, 0.84 - uv.x * 0.28, 0.36 + uv.x * 0.18, 1.0);
}
