// Typing shim: @types/node >= 22.20 dropped some legacy Buffer method
// declarations from the type surface (copy, toString(encoding)) even though
// they exist at runtime in Node and in Workers `nodejs_compat`. The vendored
// SRouter executor code uses them, so re-declare them here via merging.
// Runtime: provided by `node:buffer` under the `nodejs_compat` flag.
import "node:buffer";

declare module "node:buffer" {
    interface Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
        copy(
            target: Uint8Array,
            targetStart?: number,
            sourceStart?: number,
            sourceEnd?: number
        ): number;
        toString(encoding?: string, start?: number, end?: number): string;
    }
}
