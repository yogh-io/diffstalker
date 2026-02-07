/**
 * Generic ring/cycle data structure for focus zone navigation.
 * Tab cycles forward, Shift-Tab cycles backward, wrapping at boundaries.
 */
export class FocusRing<T> {
  private items: T[];
  private index: number;

  constructor(items: T[], initialIndex: number = 0) {
    this.items = items;
    this.index = Math.min(initialIndex, Math.max(0, items.length - 1));
  }

  current(): T {
    return this.items[this.index];
  }

  next(): T {
    this.index = (this.index + 1) % this.items.length;
    return this.items[this.index];
  }

  prev(): T {
    this.index = (this.index - 1 + this.items.length) % this.items.length;
    return this.items[this.index];
  }

  setCurrent(item: T): boolean {
    const idx = this.items.indexOf(item);
    if (idx === -1) return false;
    this.index = idx;
    return true;
  }

  setItems(items: T[], defaultItem?: T): void {
    this.items = items;
    if (defaultItem !== undefined) {
      const idx = items.indexOf(defaultItem);
      this.index = idx !== -1 ? idx : 0;
    } else {
      this.index = Math.min(this.index, Math.max(0, items.length - 1));
    }
  }
}
