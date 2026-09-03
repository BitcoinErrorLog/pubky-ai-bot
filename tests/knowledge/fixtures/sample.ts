export function ping(): string {
  return "pong";
}

export class Box {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export const NAME = "fixture";
