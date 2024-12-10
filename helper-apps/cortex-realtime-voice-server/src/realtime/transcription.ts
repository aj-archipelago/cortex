import { RealtimeItem } from './realtimeTypes.ts';

export class Transcription {
  private readonly items: Record<string, { realtimeItem: RealtimeItem, previousItemId: string }>;
  private lastItemId: string;

  constructor() {
    this.items = {};
    this.lastItemId = '';
  }

  public addItem(realtimeItem: RealtimeItem, previousItemId: string): void {
    const itemCopy = this.getItemCopy(realtimeItem);
    this.items[itemCopy.id] = {
      realtimeItem: itemCopy,
      previousItemId,
    };
    this.lastItemId = itemCopy.id;
  }

  public addTranscriptToItem(itemId: string, transcript: string): void {
    const item = this.items[itemId];
    if (item) {
      item.realtimeItem.content = [{
        type: 'input_text',
        text: transcript,
      }];
    }
  }

  public updateItem(itemId: string, realtimeItem: RealtimeItem): void {
    const newItem = this.getItemCopy(realtimeItem);
    if (newItem.role === 'assistant') {
      newItem.content = newItem.content.map((contentPart) => {
        if (contentPart.type === 'audio') {
          return { type: 'text', text: contentPart.transcript || '' };
        }
        return contentPart;
      });
    }
    this.items[itemId] = {
      realtimeItem: newItem,
      previousItemId: this.items[itemId]?.previousItemId || '',
    };
  }

  public getItem(id: string): RealtimeItem | undefined {
    return this.items[id]?.realtimeItem;
  }

  public removeItem(id: string): void {
    delete this.items[id];
  }

  public getOrderedItems(): RealtimeItem[] {
    const orderedItems: RealtimeItem[] = [];
    let currentItemId = this.lastItemId;
    while (currentItemId) {
      const item = this.items[currentItemId];
      if (item) {
        orderedItems.push(item.realtimeItem);
        currentItemId = item.previousItemId;
      } else {
        break;
      }
    }
    return orderedItems.reverse();
  }

  protected getItemCopy(item: RealtimeItem): RealtimeItem {
    const itemCopy: any = structuredClone(item);
    delete itemCopy['object'];
    return itemCopy;
  }
}
