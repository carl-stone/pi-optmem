export type Action = "wake" | "note" | "nap" | "recall" | "zoom" | "forget";
export interface Parameters {
  action: Action;
  text?: string;
  block?: string;
  query?: string;
  part?: number;
  snapshot?: number;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`OptMem requires ${field}.`);
  return value;
}

export function argumentsFor(params: Parameters): string[] {
  switch (params.action) {
    case "wake": {
      if (params.snapshot !== undefined && params.part === undefined) throw new Error("wake requires part when snapshot is provided.");
      if (params.part !== undefined && (!Number.isSafeInteger(params.part) || params.part < 1)) throw new Error("part must be a positive safe integer.");
      if (params.snapshot !== undefined && (!Number.isSafeInteger(params.snapshot) || params.snapshot < 0)) throw new Error("snapshot must be a nonnegative safe integer.");
      return ["wake", ...(params.part === undefined ? [] : [String(params.part)]), ...(params.snapshot === undefined ? [] : [String(params.snapshot)])];
    }
    case "note":
      return ["note", required(params.text, "text")];
    case "nap":
      if (params.text === undefined && params.block === undefined) return ["nap"];
      return ["nap", required(params.block, "block"), required(params.text, "text")];
    case "recall":
      return ["recall", required(params.query, "query")];
    case "zoom":
    case "forget":
      return [params.action, required(params.block, "block")];
    default:
      throw new Error("Unknown OptMem action.");
  }
}
