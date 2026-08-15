export type SensitiveRequestBody<T extends Record<string, unknown> & { data: string }> = {
  clear: () => void;
  readonly serialized: string;
  readonly value: T;
};

export function createSensitiveRequestBody<T extends Record<string, unknown> & { data: string }>(value: T): SensitiveRequestBody<T> {
  let serialized = JSON.stringify(value);
  return {
    clear: () => {
      value.data = "";
      serialized = "";
    },
    get serialized() {
      return serialized;
    },
    value,
  };
}
