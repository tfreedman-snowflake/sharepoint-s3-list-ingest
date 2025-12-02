// src/sharepoint.js
import axios from "axios";

function getHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json;odata=nometadata"
  };
}

// Get all items from the list with automatic pagination
export async function getListItems(siteUrl, listName, token) {
  let allItems = [];
  let nextUrl = `${siteUrl}/_api/web/lists/getbytitle('${listName}')/items?$top=5000`;

  while (nextUrl) {
    const res = await axios.get(nextUrl, {
      headers: getHeaders(token)
    });

    const items = res.data.value || [];
    allItems = allItems.concat(items);

    // Check for next page link (SharePoint uses odata.nextLink or __next)
    nextUrl = res.data['odata.nextLink'] || res.data['__next'] || null;
    
    if (nextUrl) {
      console.log(`  Fetched ${allItems.length} items so far, continuing...`);
    }
  }

  return allItems;
}

export async function getAttachments(siteUrl, listName, itemId, token) {
  const url = `${siteUrl}/_api/web/lists/getbytitle('${listName}')/items(${itemId})/AttachmentFiles`;

  const res = await axios.get(url, {
    headers: getHeaders(token)
  });

  return res.data.value; // array of attachments
}

// Download attachment content via SharePoint REST $value endpoint
export async function downloadAttachment(siteUrl, listName, itemId, fileName, token) {
  // Escape single quotes for REST URL
  const encodedListName = listName.replace(/'/g, "''");
  const encodedFileName = fileName.replace(/'/g, "''");

  const url = `${siteUrl}/_api/web/lists/getbytitle('${encodedListName}')/items(${itemId})/AttachmentFiles('${encodedFileName}')/$value`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    responseType: "arraybuffer"
  });

  return res.data; // Buffer
}
