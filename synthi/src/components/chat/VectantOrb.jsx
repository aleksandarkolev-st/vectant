'use client';

/**
 * VectantOrb — Vectant AI's identity: a fluid, morphing gradient orb rendered
 * with a tiny WebGL fragment shader. Solid brand-gradient colours warped like
 * liquid; the silhouette morphs through a few smooth lobes (2·3·4 harmonics)
 * plus envelope-gated higher harmonics so the "spikiness" varies over time.
 *
 * State drives a single `intensity` uniform (eased, so transitions just melt
 * the lobes back into an orb — no spin) plus an error tint:
 *   idle      → calm, nearly round, slow
 *   thinking  → faster, more lobes/amplitude, varying spikes
 *   answering → medium morph (+ a CSS pulse ring overlay)
 *   error     → gradient tints toward red
 *   applied   → CSS bloom one-shot
 *
 * Production guards:
 *   - prefers-reduced-motion → renders ONE static frame, no loop
 *   - `paused` (chat off-screen) and an IntersectionObserver stop the loop
 *   - devicePixelRatio capped at 2 so it never competes with Monaco
 *   - no WebGL → CSS gradient fallback (chat.css .vx-orb-fallback)
 */
import { useEffect, useRef } from 'react';

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

const FRAG = [
  'precision highp float;',
  'uniform float u_time,u_int,u_red;uniform vec2 u_res;',
  'vec3 ramp(float t){t=clamp(t,0.0,1.0);',
  ' vec3 pink=vec3(1.0,0.239,0.541),red=vec3(1.0,0.216,0.216),pur=vec3(0.635,0.239,1.0),blu=vec3(0.239,0.427,1.0);',
  ' if(t<0.4)return mix(pink,red,t/0.4);',
  ' if(t<0.72)return mix(red,pur,(t-0.4)/0.32);',
  ' return mix(pur,blu,(t-0.72)/0.28);}',
  'void main(){',
  ' vec2 uv=(gl_FragCoord.xy/u_res)*2.0-1.0; float r=length(uv); float ang=atan(uv.y,uv.x);',
  ' float t=u_time;',                                            // accumulated phase (no spin on state change)
  ' float amp=mix(0.04,0.135,u_int);',
  ' float lobes = 0.50*sin(ang*2.0 + t*0.90)',
  '             + 0.42*sin(ang*3.0 - t*1.00 + 1.3)',
  '             + 0.30*sin(ang*4.0 + t*0.80 + 2.1);',
  ' float e5=0.5+0.5*sin(t*0.45);',                              // slow independent envelopes
  ' float e6=0.5+0.5*sin(t*0.37 + 2.4);',                        // → spike count drifts (none/one/several)
  ' float spikeAmp=mix(0.0,0.05,u_int);',
  ' float spikes = e5*sin(ang*5.0 + t*1.30) + e6*sin(ang*6.0 - t*1.05);',
  ' float wob = amp*lobes + spikeAmp*spikes;',
  ' float rad=(0.80+wob)*(1.0+0.015*sin(t*0.6));',               // subtle breathe
  ' float a=smoothstep(rad,rad-0.045,r);',
  ' float warp=mix(0.07,0.21,u_int);',                           // solid gradient bent by smooth low-freq waves
  ' vec2 q=uv + warp*vec2( sin(uv.y*1.5 + t), sin(uv.x*1.5 - t*0.85) );',
  ' vec2 dir=normalize(vec2(0.75,0.9));',
  ' float d=dot(q,dir)*0.55+0.5;',
  ' d+=0.09*sin(dot(q,vec2(-dir.y,dir.x))*1.3 + t*0.8);',
  ' vec3 col=ramp(d);',
  ' col=mix(col, vec3(1.0,0.34,0.34), u_red*0.82);',             // error tint
  ' col+=0.22*pow(max(1.0-length(uv-vec2(-0.30,0.34)),0.0),3.0);', // top-left sheen
  ' gl_FragColor=vec4(col,a);}',
].join('\n');

const STATE_INTENSITY = { idle: 0.16, thinking: 1.0, answering: 0.5, error: 0.34, applied: 0.55 };

export default function VectantOrb({ state = 'idle', size = 120, paused = false, className = '' }) {
  const canvasRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Mutable render context, shared between the init effect and the loop effect.
  const ctx = useRef({ gl: null, draw: null, reduce: false, ok: false });
  // Eased animation values persist across loop start/stop.
  const anim = useRef({ phase: 0, intCur: STATE_INTENSITY[state] ?? 0.16, redCur: 0, last: 0 });

  // ── Init GL once per size ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reduce = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ctx.current.reduce = reduce;

    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true })
      || canvas.getContext('experimental-webgl');
    if (!gl) {
      canvas.classList.add('vx-orb-fallback');
      ctx.current.ok = false;
      return undefined;
    }

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.classList.add('vx-orb-fallback');
      ctx.current.ok = false;
      return undefined;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uT = gl.getUniformLocation(prog, 'u_time');
    const uI = gl.getUniformLocation(prog, 'u_int');
    const uRed = gl.getUniformLocation(prog, 'u_red');
    const uR = gl.getUniformLocation(prog, 'u_res');
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // One draw step. `advance` = animate phase + ease values (loop), else snap (static).
    ctx.current.draw = (now, advance) => {
      const a = anim.current;
      const targetInt = STATE_INTENSITY[stateRef.current] ?? 0.16;
      const targetRed = stateRef.current === 'error' ? 1 : 0;
      if (advance) {
        const dt = a.last ? Math.min((now - a.last) / 1000, 0.05) : 0.016;
        a.last = now;
        a.intCur += (targetInt - a.intCur) * 0.05;
        a.redCur += (targetRed - a.redCur) * 0.08;
        a.phase += dt * (0.55 + 0.85 * a.intCur);
      } else {
        a.intCur = targetInt;
        a.redCur = targetRed;
      }
      gl.uniform1f(uT, a.phase);
      gl.uniform1f(uI, a.intCur);
      gl.uniform1f(uRed, a.redCur);
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    ctx.current.gl = gl;
    ctx.current.ok = true;

    // Initial paint so the orb is visible even before the loop starts (or
    // when reduced-motion keeps it static).
    ctx.current.draw(performance.now(), false);

    return () => {
      ctx.current.ok = false;
      ctx.current.draw = null;
      ctx.current.gl = null;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    };
  }, [size]);

  // ── Animation loop: runs only when visible, not paused, motion allowed ──
  useEffect(() => {
    if (!ctx.current.ok || ctx.current.reduce) {
      // Static: just snap to the current state once.
      if (ctx.current.draw) ctx.current.draw(performance.now(), false);
      return undefined;
    }

    let raf = 0;
    let running = false;
    const start = () => {
      if (running) return;
      running = true;
      anim.current.last = 0; // reset dt baseline so resuming doesn't jump
      const loop = (now) => {
        if (!running || !ctx.current.draw) return;
        ctx.current.draw(now, true);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // Pause when the prop says so or when scrolled/docked off-screen.
    let io = null;
    let onScreen = true;
    const sync = () => { (!paused && onScreen) ? start() : stop(); };

    if (typeof IntersectionObserver !== 'undefined' && canvasRef.current) {
      io = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      });
      io.observe(canvasRef.current);
    }
    sync();

    return () => {
      stop();
      if (io) io.disconnect();
    };
  }, [paused]);

  // Keep the static (reduced-motion / paused) frame in sync when state changes.
  useEffect(() => {
    if (ctx.current.ok && (ctx.current.reduce || paused) && ctx.current.draw) {
      ctx.current.draw(performance.now(), false);
    }
  }, [state, paused]);

  return (
    <span
      className={`vx-orb ${className}`}
      data-state={state}
      style={{ '--orb-size': `${size}px` }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
      <span className="vx-orb-pulse" />
    </span>
  );
}
