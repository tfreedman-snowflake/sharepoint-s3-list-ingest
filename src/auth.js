// src/auth.js
import "dotenv/config";
import fs from "fs";
import * as msal from "@azure/msal-node";

let cca; // singleton

function getConfidentialClientApp() {
  if (cca) return cca;

  const tenantId = process.env.TENANT_ID;
  const clientId = process.env.CLIENT_ID;
  const keyPath = process.env.CERT_PRIVATE_KEY_PATH;
  const thumbprint = process.env.CERT_THUMBPRINT;

  if (!tenantId || !clientId || !keyPath || !thumbprint) {
    throw new Error(
      "TENANT_ID, CLIENT_ID, CERT_PRIVATE_KEY_PATH, CERT_THUMBPRINT must be set in .env"
    );
  }

  const privateKey = fs.readFileSync(keyPath, "utf8");

  const msalConfig = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientCertificate: {
        thumbprint,
        privateKey
      }
    }
  };

  cca = new msal.ConfidentialClientApplication(msalConfig);
  return cca;
}

export async function getAccessToken() {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) throw new Error("SITE_URL must be set in .env");

  const sharepointOrigin = new URL(siteUrl).origin; // e.g. https://yourtenant.sharepoint.com

  const clientApp = getConfidentialClientApp();

  const result = await clientApp.acquireTokenByClientCredential({
    // v2.0-style scope for SharePoint
    scopes: [`${sharepointOrigin}/.default`]
  });

  if (!result || !result.accessToken) {
    throw new Error("Failed to acquire access token for SharePoint.");
  }

  return result.accessToken;
}
