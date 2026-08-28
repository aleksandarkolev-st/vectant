import {
  isProxy,
  isSharedArrayBuffer,
  isUint8Array,
} from "node:util/types";

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;

export function validatedUint8ArrayView(
  value: unknown,
): Uint8Array | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || isProxy(value)
      || !ArrayBuffer.isView(value)
      || !isUint8Array(value)
      || TYPED_ARRAY_BUFFER_GETTER === undefined
      || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
      || TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined
    ) {
      return null;
    }
    const buffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    ) as ArrayBufferLike;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
    const byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as number;
    if (
      isSharedArrayBuffer(buffer)
      || !Number.isSafeInteger(byteLength)
      || byteLength < 0
      || !Number.isSafeInteger(byteOffset)
      || byteOffset < 0
    ) {
      return null;
    }
    return new Uint8Array(buffer, byteOffset, byteLength);
  } catch {
    return null;
  }
}

export function snapshotValidatedUint8Array(
  value: unknown,
): Buffer | null {
  const view = validatedUint8ArrayView(value);
  return view === null ? null : Buffer.from(view);
}
