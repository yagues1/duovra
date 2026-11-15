/** LRU acotada por caracteres retenidos (claves + valores), sin crecimiento por streaming. */
export class TextCache<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;

  constructor(private readonly limit: number, private readonly maxEntries = 256) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, weight: number) {
    if (weight > this.limit) return;
    const prev = this.entries.get(key);
    if (prev) { this.entries.delete(key); this.weight -= prev.weight; }
    while (this.entries.size && (this.weight + weight > this.limit || this.entries.size >= this.maxEntries)) {
      const oldest = this.entries.keys().next().value!;
      this.weight -= this.entries.get(oldest)!.weight;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
  }
}
