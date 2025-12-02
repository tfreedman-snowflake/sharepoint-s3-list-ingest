# SharePoint to S3 Sync Worker

A Node.js worker that continuously syncs SharePoint list items and attachments to AWS S3 with incremental change tracking. Designed to run in Snowpark Container Services (SPCS).

## Features

- ✅ **Incremental sync** with change detection (insert/update/delete)
- ✅ **Unlimited pagination** for large SharePoint lists
- ✅ **Certificate-based Azure AD authentication**
- ✅ **Direct S3 upload** with proper content types
- ✅ **Continuous polling** with configurable intervals

## Prerequisites

- **Snowflake account** with SPCS enabled
- **Snowflake CLI** installed: `pip install snowflake-cli-labs`
- **Docker Desktop** with support for `linux/amd64`
- **Azure AD app registration** with certificate
- **AWS S3 bucket** with IAM credentials

## Quick Setup

### 1. Configure Snowflake Connection

Create a Snowflake CLI connection:

```bash
snow connection add
```

Or edit `~YOUR_USER/.snowflake/connections.toml`:

```toml
[your_conn]
account = "your-account"
user = "your-username"
password = "your-password"
role = "ACCOUNTADMIN"
warehouse = "COMPUTE_WH"
```

### 2. Prepare Certificate

Convert your certificate to single-line format for Snowflake secrets:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' sharepoint-worker.key
```

Save the output - you'll need it for `snowflake-setup.sql`.

### 3. Build and Push Docker Image

**CRITICAL:** Snowflake requires `linux/amd64` platform.

```bash
# Login to Snowflake image registry
snow spcs image-registry login --connection your_conn

# Build for linux/amd64 (REQUIRED for Snowflake)
docker build --platform linux/amd64 -t sharepoint-sync-worker .

# Get your repository URL from Snowflake
# Run in Snowflake: SHOW IMAGE REPOSITORIES;
# Copy the repository_url value

# Tag the image
docker tag sharepoint-sync-worker <your_repo_url>/sharepoint-sync-worker:latest

# Push to Snowflake
docker push <your_repo_url>/sharepoint-sync-worker:latest
```

**Example with actual repository URL:**

```bash
snow spcs image-registry login --connection my_conn
docker build --platform linux/amd64 -t sharepoint-sync-worker .
docker tag sharepoint-sync-worker orgname-account.registry.snowflakecomputing.com/sharepoint_sync_db/services/sharepoint_sync_repo/sharepoint-sync-worker:latest
docker push orgname-account.registry.snowflakecomputing.com/sharepoint_sync_db/services/sharepoint_sync_repo/sharepoint-sync-worker:latest
```

### 4. Configure and Deploy

Edit `snowflake-setup.sql` and replace:

- **Line 56:** `yourtenant.sharepoint.com` → your actual SharePoint tenant
- **Lines 79-119:** All secret values (Azure credentials, AWS credentials, certificate)

Run the setup:

```bash
snow sql -f snowflake-setup.sql --connection your_conn
```

Or in Snowsight:
1. Open **Projects** → **Worksheets**
2. Paste contents of `snowflake-setup.sql`
3. Execute step by step

### 5. Monitor the Service

```sql
-- Check service status
CALL SYSTEM$GET_SERVICE_STATUS('sharepoint_sync_service');

-- View logs
CALL SYSTEM$GET_SERVICE_LOGS('sharepoint_sync_service', '0', 'sharepoint-worker', 100);

-- Check compute pool
DESC COMPUTE POOL SHAREPOINT_SYNC_POOL;
```

## Data Structure in S3

```
s3://your-bucket/
  └── sharepoint-data/
      └── list=LIST_NAME/
          ├── _state/
          │   └── sync_state.json          # Tracks sync state
          ├── item_id=1/
          │   ├── row.json                 # Item data with operation_type
          │   ├── attachments_meta.json    # Attachment metadata
          │   └── attachments/
          │       └── document.pdf
          └── item_id=2/
              └── deletion_marker.json     # Created when item deleted
```

## Operation Types

Each synced item includes metadata indicating the operation:

- **insert** - New item (first time seen)
- **update** - Modified item (newer `Modified` date)
- **delete** - Item removed from SharePoint

## Managing the Service

```sql
-- Suspend (stop polling)
ALTER SERVICE sharepoint_sync_service SUSPEND;

-- Resume
ALTER SERVICE sharepoint_sync_service RESUME;

-- View detailed status
SHOW SERVICES;
DESC SERVICE sharepoint_sync_service;

-- Drop service
DROP SERVICE sharepoint_sync_service;

-- Drop compute pool (after dropping service)
DROP COMPUTE POOL SHAREPOINT_SYNC_POOL;
```

## Updating the Service

After code changes:

```bash
# Rebuild and push with new version tag
docker build --platform linux/amd64 -t sharepoint-sync-worker .
docker tag sharepoint-sync-worker <your_repo_url>/sharepoint-sync-worker:v2
docker push <your_repo_url>/sharepoint-sync-worker:v2
```

```sql
-- Update service to use new image
ALTER SERVICE sharepoint_sync_service FROM SPECIFICATION $$
  spec:
    containers:
    - name: sharepoint-worker
      image: /sharepoint_sync_db/services/sharepoint_sync_repo/sharepoint-sync-worker:v2
      # ... rest of spec unchanged ...
$$;
```

## Troubleshooting

### Network Errors (ENOTFOUND)

If you see `ENOTFOUND` errors for S3 or SharePoint:

```sql
-- Update network rules to include your specific domains
ALTER NETWORK RULE s3_network_rule SET VALUE_LIST = (
  '*.s3.amazonaws.com:443',
  '*.s3.us-west-2.amazonaws.com:443'
);

ALTER NETWORK RULE sharepoint_network_rule SET VALUE_LIST = (
  'yourtenant.sharepoint.com:443',
  '*.sharepoint.com:443'
);
```

### Authentication Errors

```sql
-- Verify secrets are set correctly
SHOW SECRETS;

-- Update a secret
ALTER SECRET azure_tenant_id SET SECRET_STRING = 'new-value';
```

### Check Logs

```sql
-- Last 200 lines
CALL SYSTEM$GET_SERVICE_LOGS('sharepoint_sync_service', '0', 'sharepoint-worker', 200);

-- Filter for errors
CALL SYSTEM$GET_SERVICE_LOGS('sharepoint_sync_service', '0', 'sharepoint-worker', 500);
-- Then search output for "error" or "failed"
```

### Wrong Platform

If you get `exec format error`:

```bash
# Verify image platform
docker image inspect sharepoint-sync-worker | grep Architecture
# Must show: "Architecture": "amd64"

# Rebuild with correct platform
docker build --platform linux/amd64 -t sharepoint-sync-worker .
```