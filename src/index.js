// src/index.js
import "dotenv/config";
import { getAccessToken } from "./auth.js";
import { getListItems, getAttachments, downloadAttachment } from "./sharepoint.js";
import { uploadToS3, uploadJSONToS3 } from "./s3.js";
import StateTracker from "./state.js";

// Graceful shutdown handling
let isShuttingDown = false;
let currentSyncPromise = null;

function sanitizeFileName(name) {
  // basic safety for filesystem
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getContentType(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  const types = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'txt': 'text/plain',
    'json': 'application/json'
  };
  return types[ext] || 'application/octet-stream';
}

async function processItem(siteUrl, listName, item, token, stateTracker, s3Prefix) {
  const itemId = item.Id;
  const modified = item.Modified || new Date().toISOString();
  
  // Determine operation type
  const operationType = stateTracker.getOperationType(itemId, modified);
  
  // Always fetch attachment metadata for state tracking (lightweight API call)
  const attachments = await getAttachments(siteUrl, listName, itemId, token);
  
  // Record item in current state - CRITICAL: must happen for ALL items
  stateTracker.recordItem(itemId, modified, attachments.length);
  
  // Skip upload if unchanged and SKIP_UNCHANGED is enabled
  if (operationType === 'unchanged' && process.env.SKIP_UNCHANGED === 'true') {
    // Only log every 100th unchanged item to reduce noise
    if (itemId % 100 === 0) {
      console.log(`  Skipped ${itemId} unchanged items so far...`);
    }
    return;
  }

  console.log(`Processing item ${itemId} [${operationType.toUpperCase()}]...`);
  console.log(`  Found ${attachments.length} attachments for item ${itemId}.`);

  // S3 key prefix for this item
  const itemPrefix = `${s3Prefix}list=${listName}/item_id=${itemId}/`;

  // Add operation metadata to item
  const itemWithMetadata = {
    ...item,
    _sync_metadata: {
      operation_type: operationType,
      synced_at: new Date().toISOString(),
      attachment_count: attachments.length,
      list_name: listName
    }
  };

  // 2) Upload the row JSON to S3
  const rowKey = `${itemPrefix}row.json`;
  await uploadJSONToS3(rowKey, itemWithMetadata);
  console.log(`  Uploaded row data to S3: s3://${process.env.S3_BUCKET}/${rowKey}`);

  const attachmentsMeta = [];

  for (const att of attachments) {
    const safeFileName = sanitizeFileName(att.FileName);
    const contentType = getContentType(att.FileName);

    // Download the binary content via REST $value endpoint
    const content = await downloadAttachment(
      siteUrl,
      listName,
      itemId,
      att.FileName,
      token
    );

    // S3 key for attachment
    const attachmentKey = `${itemPrefix}attachments/${safeFileName}`;
    await uploadToS3(attachmentKey, content, contentType);
    console.log(`    Uploaded attachment to S3: s3://${process.env.S3_BUCKET}/${attachmentKey}`);

    const origin = new URL(siteUrl).origin;

    // Build metadata object
    attachmentsMeta.push({
      list_name: listName,
      item_id: itemId,
      file_name: att.FileName,
      safe_file_name: safeFileName,
      server_relative_url: att.ServerRelativeUrl,
      download_url: `${origin}${att.ServerRelativeUrl}`,
      s3_key: attachmentKey,
      s3_url: `s3://${process.env.S3_BUCKET}/${attachmentKey}`
    });
  }

  // 3) Upload attachments metadata to S3 (even if empty)
  const metaKey = `${itemPrefix}attachments_meta.json`;
  await uploadJSONToS3(metaKey, attachmentsMeta);
  console.log(`  Uploaded attachments metadata to S3: s3://${process.env.S3_BUCKET}/${metaKey}`);
}

async function processDeletedItems(listName, deletedItems, s3Prefix) {
  console.log(`\nProcessing ${deletedItems.length} deleted items...`);
  
  for (const deleted of deletedItems) {
    const itemId = deleted.itemId;
    const itemPrefix = `${s3Prefix}list=${listName}/item_id=${itemId}/`;
    
    // Create a deletion marker
    const deletionMarker = {
      item_id: itemId,
      _sync_metadata: {
        operation_type: 'delete',
        synced_at: new Date().toISOString(),
        deleted_at: new Date().toISOString(),
        last_seen: deleted.lastSeen,
        list_name: listName
      },
      note: "This item was present in previous sync but is now deleted from SharePoint"
    };

    const deletionKey = `${itemPrefix}deletion_marker.json`;
    await uploadJSONToS3(deletionKey, deletionMarker);
    console.log(`  Created deletion marker: s3://${process.env.S3_BUCKET}/${deletionKey}`);
  }
}

async function runSync() {
  const siteUrl = process.env.SITE_URL;
  const listName = process.env.LIST_NAME;
  const s3Prefix = process.env.S3_PREFIX || "";

  if (!siteUrl || !listName) {
    throw new Error("SITE_URL and LIST_NAME must be set in .env");
  }

  console.log("\n" + "=".repeat(80));
  console.log(`Starting sync at ${new Date().toISOString()}`);
  console.log("=".repeat(80));

  // Initialize state tracker
  const stateTracker = new StateTracker(listName);
  await stateTracker.loadPreviousState();

  console.log("\nGetting access token...");
  const token = await getAccessToken();
  console.log("Access token acquired.");

  console.log(`\nFetching items from list '${listName}'...`);
  const items = await getListItems(siteUrl, listName, token);
  console.log(`Found ${items.length} items.`);

  // Process each item
  for (const item of items) {
    if (isShuttingDown) {
      console.log("\nShutdown requested, stopping item processing...");
      break;
    }
    
    await processItem(siteUrl, listName, item, token, stateTracker, s3Prefix);
  }

  // Handle deleted items
  if (!isShuttingDown) {
    const deletedItems = stateTracker.getDeletedItems();
    if (deletedItems.length > 0) {
      await processDeletedItems(listName, deletedItems, s3Prefix);
    }
  }

  // Save current state for next run
  if (!isShuttingDown) {
    console.log("\nSaving sync state...");
    await stateTracker.saveCurrentState();
  }

  // Print statistics
  const stats = stateTracker.getStats();
  console.log("\n" + "=".repeat(80));
  console.log("Sync Statistics:");
  console.log(`  Inserts:   ${stats.inserts}`);
  console.log(`  Updates:   ${stats.updates}`);
  console.log(`  Deletes:   ${stats.deletes}`);
  console.log(`  Unchanged: ${stats.unchanged}`);
  console.log(`  Total:     ${stats.total}`);
  console.log("=".repeat(80));
  console.log(`Sync completed at ${new Date().toISOString()}\n`);
}

async function runContinuous() {
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_SECONDS || "300", 10) * 1000;
  const runOnce = process.env.RUN_ONCE === "true";

  console.log(`SharePoint Sync Worker Starting...`);
  console.log(`Mode: ${runOnce ? "Single run" : "Continuous"}`);
  if (!runOnce) {
    console.log(`Poll Interval: ${pollIntervalMs / 1000} seconds`);
  }

  while (!isShuttingDown) {
    try {
      currentSyncPromise = runSync();
      await currentSyncPromise;
      
      if (runOnce) {
        console.log("Single run completed. Exiting...");
        break;
      }

      if (!isShuttingDown) {
        console.log(`Waiting ${pollIntervalMs / 1000} seconds until next sync...`);
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      console.error("\n" + "!".repeat(80));
      console.error("Sync failed with error:");
      
      // Improved debug: show HTTP status/body if this came from axios
      if (err && err.response) {
        const { status, statusText, headers, data } = err.response;

        let bodyPreview;
        if (Buffer.isBuffer(data)) {
          bodyPreview = data.toString("utf8");
        } else if (typeof data === "string") {
          bodyPreview = data;
        } else {
          try {
            bodyPreview = JSON.stringify(data, null, 2);
          } catch {
            bodyPreview = String(data);
          }
        }

        console.error("  Status:", status, statusText);
        console.error("  Headers:", headers);
        console.error("  Body:", bodyPreview);
      } else {
        console.error(err);
      }
      console.error("!".repeat(80) + "\n");

      if (runOnce) {
        process.exit(1);
      }

      // Wait before retrying on error
      const retryDelay = 60000; // 1 minute
      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      await sleep(retryDelay);
    }
  }

  console.log("Worker stopped gracefully.");
}

function sleep(ms) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    
    // Allow early wakeup on shutdown
    const checkShutdown = setInterval(() => {
      if (isShuttingDown) {
        clearTimeout(timeout);
        clearInterval(checkShutdown);
        resolve();
      }
    }, 1000);
  });
}

// Graceful shutdown handlers
function setupShutdownHandlers() {
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    
    console.log(`\n${signal} received. Shutting down gracefully...`);
    isShuttingDown = true;

    // Wait for current sync to complete (with timeout)
    if (currentSyncPromise) {
      console.log("Waiting for current sync to complete...");
      const timeout = new Promise(resolve => setTimeout(resolve, 30000));
      await Promise.race([currentSyncPromise, timeout]);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the worker
setupShutdownHandlers();
runContinuous().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
