import { describe, expect, it } from 'vitest';
import { findCommandHostEscape } from '../hostEscape';

describe('findCommandHostEscape', () => {
  it('allows the legitimate workspace mount + a benign docker run', () => {
    expect(findCommandHostEscape('docker run --rm -p 6901:6901 -v "$PWD":/workspace -w /workspace img')).toBeNull();
    expect(findCommandHostEscape('npm run dev')).toBeNull();
    expect(findCommandHostEscape('')).toBeNull();
  });

  it('rejects a docker.sock mount (portainer-style)', () => {
    expect(findCommandHostEscape('docker run -v /var/run/docker.sock:/var/run/docker.sock img'))
      .toMatch(/docker\.sock|var\/run/i);
  });

  it('rejects --privileged, --cap-add, --security-opt, --device', () => {
    expect(findCommandHostEscape('docker run --privileged img')).toMatch(/privileged/i);
    expect(findCommandHostEscape('docker run --cap-add=SYS_ADMIN img')).toMatch(/cap-add/i);
    expect(findCommandHostEscape('docker run --security-opt seccomp=unconfined img')).toMatch(/security-opt/i);
    expect(findCommandHostEscape('docker run --device /dev/sda img')).toMatch(/device/i);
  });

  it('rejects an absolute-path host bind mount but not $PWD', () => {
    expect(findCommandHostEscape('docker run -v /etc:/etc img')).toMatch(/-v|volume/i);
    expect(findCommandHostEscape('docker run --volume /home/u:/data img')).toMatch(/-v|volume/i);
    expect(findCommandHostEscape('docker run -v "$PWD/.cache":/c img')).toBeNull();
  });
});
