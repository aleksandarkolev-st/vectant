import { describe, expect, it } from 'vitest';
import { findCommandHostEscape } from '../hostEscape.js';

describe('findCommandHostEscape', () => {
  it('flags docker.sock', () => {
    expect(findCommandHostEscape('docker run -v /var/run/docker.sock:/var/run/docker.sock x')).toBeTruthy();
  });
  it('flags --privileged / --cap-add / --device', () => {
    expect(findCommandHostEscape('docker run --privileged x')).toBeTruthy();
    expect(findCommandHostEscape('docker run --cap-add=SYS_ADMIN x')).toBeTruthy();
    expect(findCommandHostEscape('docker run --device /dev/kvm x')).toBeTruthy();
  });
  it('flags an absolute host bind mount', () => {
    expect(findCommandHostEscape('docker run -v /etc:/etc x')).toBeTruthy();
  });
  it('allows the workspace mount and plain commands', () => {
    expect(findCommandHostEscape('docker run -v "$PWD":/workspace x')).toBeNull();
    expect(findCommandHostEscape('npm run dev')).toBeNull();
    expect(findCommandHostEscape('')).toBeNull();
  });
});
