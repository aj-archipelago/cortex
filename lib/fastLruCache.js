// This class implements a fast O(1) LRU cache using a Map and a doubly linked list.

class Node {
    constructor(key, value) {
        this.key = key;
        this.value = value;
        this.next = null;
        this.prev = null;
    }
}

class FastLRUCache {
    constructor(capacity) {
        this.capacity = capacity;
        this.cache = new Map();
        this.head = null;
        this.tail = null;
    }

    get(key) {
        if (!this.cache.has(key)) {
            return -1;
        }
        const node = this.cache.get(key);
        this.moveToEnd(node);
        return node.value;
    }

    put(key, value) {
        if (this.cache.has(key)) {
            const node = this.cache.get(key);
            node.value = value;
            this.moveToEnd(node);
        } else {
            const node = new Node(key, value);
            if (this.cache.size >= this.capacity) {
                this.cache.delete(this.head.key);
                this.shiftHeadToNext();
            }
            this.cache.set(key, node);
            this.addNodeToTail(node);
        }
    }

    addNodeToTail(node) {
        if (!this.tail) {
            this.head = node;
            this.tail = node;
        } else {
            node.prev = this.tail;
            this.tail.next = node;
            this.tail = node;
        }
    }

    moveToEnd(node) {
        if (node === this.tail) {
            return;
        }
        if (node === this.head) {
            this.shiftHeadToNext();
        } else {
            node.prev.next = node.next;
            node.next.prev = node.prev;
        }
        node.prev = this.tail;
        node.next = null;
        this.tail.next = node;
        this.tail = node;
    }

    shiftHeadToNext() {
        this.head = this.head.next;
        if (this.head) {
            this.head.prev = null;
        } else {
            this.tail = null;
        }
    }
}

export { FastLRUCache };