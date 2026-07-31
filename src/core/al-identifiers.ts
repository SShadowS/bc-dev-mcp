// AL identifiers are case-insensitive. Keep the transformation length-preserving so legal
// quoted identifiers such as "Größe" are not silently expanded. This matches the compiler-facing
// normalization used by the procedure identity engine.
export function upperInvariantUtf16(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const unit = value[index]!;
    const upper = unit.toUpperCase();
    result += upper.length === 1 ? upper : unit;
  }
  return result;
}
