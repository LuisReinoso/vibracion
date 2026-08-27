// Minimal WebGL2 helpers: compile, fullscreen triangle, textures and FBOs.

export function getContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  return gl;
}

export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error:\n' + log + '\n---\n' + numbered(src));
  }
  return sh;
}

function numbered(src) {
  return src.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n');
}

export const QUAD_VS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export function program(gl, fsSrc, vsSrc = QUAD_VS) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link error:\n' + log);
  }
  return new Program(gl, p);
}

class Program {
  constructor(gl, handle) {
    this.gl = gl;
    this.handle = handle;
    this.loc = new Map();
    this.unit = 0;
  }
  use() {
    this.gl.useProgram(this.handle);
    this.unit = 0;
    return this;
  }
  u(name) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.handle, name));
    return this.loc.get(name);
  }
  f(name, v) { this.gl.uniform1f(this.u(name), v); return this; }
  i(name, v) { this.gl.uniform1i(this.u(name), v); return this; }
  v2(name, a, b) { this.gl.uniform2f(this.u(name), a, b); return this; }
  v3(name, a, b, c) { this.gl.uniform3f(this.u(name), a, b, c); return this; }
  v4a(name, arr) { this.gl.uniform4fv(this.u(name), arr); return this; }
  tex(name, texture) {
    const gl = this.gl;
    const unit = this.unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.u(name), unit);
    return this;
  }
}

export function quadVAO(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function createTexture(gl, w, h, internalFormat, format, type, data = null, filter = null) {
  const t = gl.createTexture();
  const f = filter ?? gl.NEAREST;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}

export function createFBO(gl, texture) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer: 0x' + st.toString(16));
  return fbo;
}

// Texture + FBO pair for ping-pong.
export function pingpong(gl, w, h, internalFormat, format, type) {
  const make = () => {
    const tex = createTexture(gl, w, h, internalFormat, format, type);
    return { tex, fbo: createFBO(gl, tex) };
  };
  const a = make();
  const b = make();
  return {
    read: a,
    write: b,
    swap() { const t = this.read; this.read = this.write; this.write = t; },
  };
}
