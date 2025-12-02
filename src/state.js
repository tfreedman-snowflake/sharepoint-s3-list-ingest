// src/state.js
import "dotenv/config";
import { uploadJSONToS3, downloadFromS3, checkS3ObjectExists } from "./s3.js";

/**
 * State tracker for incremental sync
 * Maintains a record of all items and their last sync state
 */
class StateTracker {
  constructor(listName) {
    this.listName = listName;
    this.stateKey = this.getStateKey();
    this.previousState = null;
    this.currentState = new Map(); // itemId -> { Modified, hash, ... }
  }

  getStateKey() {
    const s3Prefix = process.env.S3_PREFIX || "";
    return `${s3Prefix}list=${this.listName}/_state/sync_state.json`;
  }

  /**
   * Load the previous sync state from S3
   */
  async loadPreviousState() {
    try {
      const exists = await checkS3ObjectExists(this.stateKey);
      if (!exists) {
        console.log("  No previous state found - this is the first run.");
        this.previousState = new Map();
        return;
      }

      const stateData = await downloadFromS3(this.stateKey);
      const parsed = JSON.parse(stateData);
      
      // Convert array back to Map
      this.previousState = new Map(parsed.items || []);
      console.log(`  Loaded previous state: ${this.previousState.size} items tracked.`);
    } catch (err) {
      console.warn("  Failed to load previous state, treating as first run:", err.message);
      this.previousState = new Map();
    }
  }

  /**
   * Record an item in current state
   */
  recordItem(itemId, modified, attachmentCount = 0) {
    this.currentState.set(itemId.toString(), {
      modified: modified,
      attachmentCount: attachmentCount,
      lastSeen: new Date().toISOString()
    });
  }

  /**
   * Determine the operation type for an item
   * @returns {'insert' | 'update' | 'unchanged'}
   */
  getOperationType(itemId, modified) {
    const id = itemId.toString();
    
    if (!this.previousState || !this.previousState.has(id)) {
      return 'insert'; // New item
    }

    const previous = this.previousState.get(id);
    const prevModified = new Date(previous.modified).getTime();
    const currModified = new Date(modified).getTime();

    if (currModified > prevModified) {
      return 'update'; // Item was modified
    }

    return 'unchanged'; // No changes
  }

  /**
   * Get items that were deleted (present in previous state but not current)
   */
  getDeletedItems() {
    if (!this.previousState || this.previousState.size === 0) {
      return [];
    }

    const deleted = [];
    for (const [itemId, data] of this.previousState.entries()) {
      if (!this.currentState.has(itemId)) {
        deleted.push({
          itemId: parseInt(itemId),
          ...data
        });
      }
    }

    return deleted;
  }

  /**
   * Save current state to S3 for next sync
   */
  async saveCurrentState() {
    const stateData = {
      listName: this.listName,
      lastSync: new Date().toISOString(),
      itemCount: this.currentState.size,
      items: Array.from(this.currentState.entries())
    };

    await uploadJSONToS3(this.stateKey, stateData);
    console.log(`  Saved current state: ${this.currentState.size} items.`);
  }

  /**
   * Get statistics about the sync
   */
  getStats() {
    const deleted = this.getDeletedItems();
    let inserts = 0;
    let updates = 0;
    let unchanged = 0;

    for (const [itemId] of this.currentState.entries()) {
      // Reconstruct modified date from current state (we need to pass it separately in real usage)
      const state = this.currentState.get(itemId);
      const opType = this.getOperationType(itemId, state.modified);
      
      if (opType === 'insert') inserts++;
      else if (opType === 'update') updates++;
      else unchanged++;
    }

    return {
      inserts,
      updates,
      deletes: deleted.length,
      unchanged,
      total: this.currentState.size
    };
  }
}

export default StateTracker;

