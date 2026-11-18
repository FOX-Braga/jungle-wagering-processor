export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function jsonSnapshot<T extends JsonObject>(data: T): T {
  const copy = structuredClone(data);

  function freeze(value: JsonValue): void {
    if (value === null || typeof value !== "object") return;

    for (const child of Object.values<JsonValue>(value)) freeze(child);
    Object.freeze(value);
  }

  freeze(copy);
  return copy;
}
