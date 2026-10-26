interface Expiry {
  id: string;
  expiresAt: number;
}

/**
 * Indexed min-heap, independent of LRU order. Replacements and removals also
 * remove their heap nodes, so a frequently replaced ID cannot grow the index.
 * Ordering by deadline handles clock rollback without scanning live entries.
 */
export class ExpiryIndex {
  private readonly heap: Expiry[] = [];
  private readonly positions = new Map<string, number>();

  set(id: string, expiresAt: number): void {
    this.delete(id);
    const position = this.heap.length;
    this.heap.push({ id, expiresAt });
    this.positions.set(id, position);
    this.siftUp(position);
  }

  /** TTL is inclusive: an entry remains live at its exact deadline. */
  nextExpired(now: number): string | undefined {
    const first = this.heap[0];
    return first && first.expiresAt < now ? first.id : undefined;
  }

  delete(id: string): void {
    const position = this.positions.get(id);
    if (position === undefined) return;
    const last = this.heap.pop()!;
    this.positions.delete(id);
    if (position === this.heap.length) return;
    this.heap[position] = last;
    this.positions.set(last.id, position);
    const parent = Math.floor((position - 1) / 2);
    if (position > 0 && last.expiresAt < this.heap[parent].expiresAt) this.siftUp(position);
    else this.siftDown(position);
  }

  clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }

  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a].id, a);
    this.positions.set(this.heap[b].id, b);
  }

  private siftUp(position: number): void {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.heap[parent].expiresAt <= this.heap[position].expiresAt) break;
      this.swap(parent, position);
      position = parent;
    }
  }

  private siftDown(position: number): void {
    for (;;) {
      const left = position * 2 + 1;
      if (left >= this.heap.length) return;
      const right = left + 1;
      const child = right < this.heap.length && this.heap[right].expiresAt < this.heap[left].expiresAt ? right : left;
      if (this.heap[position].expiresAt <= this.heap[child].expiresAt) return;
      this.swap(position, child);
      position = child;
    }
  }
}
