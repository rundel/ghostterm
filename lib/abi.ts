/**
 * Layout information for the libghostty-vt WebAssembly module.
 *
 * libghostty-vt publishes a machine-readable description of its C ABI through
 * `ghostty_type_json()`: struct sizes and field offsets, and the bit positions
 * inside packed values such as `GhosttyCell`. Bit positions of packed values are
 * explicitly not covered by the ABI promise, so they are read from the manifest
 * of the loaded module instead of being hard-coded here.
 */

interface ManifestField {
  offset: number;
  size: number;
  type: string;
}

interface ManifestBits {
  lsb: number;
  width: number;
}

interface ManifestType {
  kind: string;
  size?: number;
  align?: number;
  fields?: Record<string, ManifestField>;
  bits?: Record<string, ManifestBits & Record<string, unknown>>;
  values?: Record<string, number>;
}

interface Manifest {
  abi: { pointer_size: number; usize_size: number; endian: string };
  library_version?: string;
  types: Record<string, ManifestType>;
}

/** A bit field inside a packed value of up to 64 bits. */
export interface BitField {
  lsb: number;
  width: number;
}

/**
 * Read `width` bits starting at `lsb` from a 64-bit value given as its low and
 * high 32-bit halves. Fields wider than 32 bits are not supported.
 */
export function readBits(lo: number, hi: number, field: BitField): number {
  const { lsb, width } = field;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  if (lsb >= 32) return (hi >>> (lsb - 32)) & mask;
  if (lsb + width <= 32) return (lo >>> lsb) & mask;
  const loBits = 32 - lsb;
  return ((lo >>> lsb) | (hi << loBits)) & mask;
}

export class AbiLayout {
  readonly version: string | undefined;
  private types: Record<string, ManifestType>;

  constructor(json: string) {
    const manifest = JSON.parse(json) as Manifest;
    if (manifest.abi.pointer_size !== 4 || manifest.abi.endian !== 'little') {
      throw new Error(
        `Unsupported libghostty-vt ABI: pointer size ${manifest.abi.pointer_size}, ${manifest.abi.endian} endian`
      );
    }
    this.version = manifest.library_version;
    this.types = manifest.types;
  }

  private type(name: string): ManifestType {
    const t = this.types[name];
    if (!t) throw new Error(`libghostty-vt manifest has no type ${name}`);
    return t;
  }

  /** Size in bytes of a type. */
  size(name: string): number {
    const size = this.type(name).size;
    if (size === undefined) throw new Error(`libghostty-vt type ${name} has no size`);
    return size;
  }

  /** Byte offset of a struct field. */
  offset(struct: string, field: string): number {
    const f = this.type(struct).fields?.[field];
    if (!f) throw new Error(`libghostty-vt struct ${struct} has no field ${field}`);
    return f.offset;
  }

  /** Bit position of a field in a packed type. */
  bits(packed: string, field: string): BitField {
    const b = this.type(packed).bits?.[field];
    if (!b) throw new Error(`libghostty-vt packed type ${packed} has no field ${field}`);
    return { lsb: b.lsb, width: b.width };
  }

  /** Bit position of a field nested inside a union arm of a packed type. */
  unionBits(packed: string, field: string, arm: string, inner: string): BitField {
    const outer = this.type(packed).bits?.[field] as
      | (ManifestBits & { arms?: Record<string, { bits: Record<string, ManifestBits> }> })
      | undefined;
    const b = outer?.arms?.[arm]?.bits?.[inner];
    if (!outer || !b) {
      throw new Error(`libghostty-vt packed type ${packed} has no ${field}.${arm}.${inner}`);
    }
    return { lsb: outer.lsb + b.lsb, width: b.width };
  }
}
