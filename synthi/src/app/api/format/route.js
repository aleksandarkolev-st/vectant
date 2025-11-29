import { NextResponse } from 'next/server';
import { spawn } from 'child_process';

async function runFormatter(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout });
      return reject(new Error(`Formatter exited with code ${code}: ${stderr}`));
    });

    if (input) {
      try {
        proc.stdin.write(input);
      } catch (e) {}
    }
    try { proc.stdin.end(); } catch(e) {}
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { language, code } = body || {};
    if (!language || typeof code !== 'string') {
      return NextResponse.json({ error: 'Missing language or code' }, { status: 400 });
    }

    // Choose formatter command/args based on language
    let cmd = null;
    let args = [];
    if (language === 'rust' || language === 'rs') {
      // rustfmt reads stdin and can emit to stdout with --emit stdout
      cmd = 'rustfmt';
      args = ['--emit', 'stdout'];
    } else if (language === 'cpp' || language === 'c' || language === 'c++') {
      cmd = 'clang-format';
      args = [];
    } else if (language === 'javascript' || language === 'typescript' || language === 'js' || language === 'ts') {
      // Defer to prettier if available on server env
      cmd = 'prettier';
      args = ['--stdin-filepath', 'file.' + (language === 'typescript' || language === 'ts' ? 'ts' : 'js')];
    } else {
      return NextResponse.json({ error: `Unsupported language: ${language}` }, { status: 400 });
    }

    try {
      const out = await runFormatter(cmd, args, code);
      return NextResponse.json({ formatted: out.stdout }, { status: 200 });
    } catch (err) {
      console.error('Formatting error:', err);
      return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
    }
  } catch (err) {
    console.error('Format route error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
