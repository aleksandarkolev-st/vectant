import { describe, expect, it } from 'vitest';
import { getMonacoLanguage } from './languageMapper';

describe('getMonacoLanguage C and C++ detection', () => {
  it.each([
    ['main.cpp', 'cpp'],
    ['engine.cc', 'cpp'],
    ['module.cxx', 'cpp'],
    ['library.c++', 'cpp'],
    ['public.hpp', 'cpp'],
    ['public.hh', 'cpp'],
    ['public.hxx', 'cpp'],
    ['template.ipp', 'cpp'],
    ['generated.inl', 'cpp'],
    ['legacy.h', 'c'],
    ['legacy.c', 'c'],
  ])('maps %s to %s', (fileName, expectedLanguage) => {
    expect(getMonacoLanguage(fileName)).toBe(expectedLanguage);
  });
});
