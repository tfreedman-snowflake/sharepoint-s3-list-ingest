-- ============================================================================
-- Snowpark Container Services (SPCS) Setup for SharePoint Sync Worker
-- ============================================================================

-- Step 1: Create Database and Schema
-- ============================================================================
CREATE DATABASE IF NOT EXISTS SHAREPOINT_SYNC_DB;
USE DATABASE SHAREPOINT_SYNC_DB;

CREATE SCHEMA IF NOT EXISTS SERVICES;
USE SCHEMA SERVICES;

-- Step 2: Create Image Repository
-- ============================================================================
CREATE IMAGE REPOSITORY IF NOT EXISTS SHAREPOINT_SYNC_REPO;

-- Grant privileges to use the repository
GRANT READ, WRITE ON IMAGE REPOSITORY SHAREPOINT_SYNC_REPO TO ROLE SYSADMIN;

-- Show the repository URL (you'll need this for pushing the image)
SHOW IMAGE REPOSITORIES IN SCHEMA SERVICES;

-- Step 3: Create Network Rules for External Access
-- ============================================================================

-- Network rule for AWS S3 (adjust as needed)
-- IMPORTANT: S3 uses bucket-specific endpoints like bucket-name.s3.region.amazonaws.com
CREATE OR REPLACE NETWORK RULE s3_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = (
    's3.amazonaws.com:443',
    '*.s3.amazonaws.com:443',
    's3.us-east-1.amazonaws.com:443',
    '*.s3.us-east-1.amazonaws.com:443',
    's3.us-west-2.amazonaws.com:443',
    '*.s3.us-west-2.amazonaws.com:443',
    's3-external-1.amazonaws.com:443',
    '*.s3-external-1.amazonaws.com:443',
    's3.dualstack.us-east-1.amazonaws.com:443',
    '*.s3.dualstack.us-east-1.amazonaws.com:443',
    's3.dualstack.us-west-2.amazonaws.com:443',
    '*.s3.dualstack.us-west-2.amazonaws.com:443'
  );

-- Network rule for Azure AD/Microsoft Login (adjust as needed)
CREATE OR REPLACE NETWORK RULE azure_auth_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = (
    'login.microsoftonline.com:443',
    'login.microsoft.com:443',
    'graph.microsoft.com:443'
  );

-- Network rule for SharePoint Online (adjust for your tenant)
-- IMPORTANT: Replace 'yourtenant' with your actual tenant name
CREATE OR REPLACE NETWORK RULE sharepoint_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = (
    'yourtenant.sharepoint.com:443',
    '*.sharepoint.com:443'
  );

-- Step 4: Create External Access Integration
-- ============================================================================
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION sharepoint_sync_external_access
  ALLOWED_NETWORK_RULES = (
    s3_network_rule,
    azure_auth_network_rule,
    sharepoint_network_rule
  )
  ENABLED = TRUE;


-- Step 5: Create Secrets for Credentials
-- ============================================================================

-- Azure AD Credentials
CREATE OR REPLACE SECRET azure_tenant_id
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-tenant-id-here';

CREATE OR REPLACE SECRET azure_client_id
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-client-id-here';

CREATE OR REPLACE SECRET azure_cert_thumbprint
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-cert-thumbprint-here';

-- SharePoint Configuration
CREATE OR REPLACE SECRET sharepoint_site_url
  TYPE = GENERIC_STRING
  SECRET_STRING = 'https://yourtenant.sharepoint.com/sites/yoursite';

CREATE OR REPLACE SECRET sharepoint_list_name
  TYPE = GENERIC_STRING
  SECRET_STRING = 'YourListName';

-- AWS S3 Credentials
CREATE OR REPLACE SECRET aws_access_key_id
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-aws-access-key-id';

CREATE OR REPLACE SECRET aws_secret_access_key
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-aws-secret-access-key';

CREATE OR REPLACE SECRET aws_s3_bucket
  TYPE = GENERIC_STRING
  SECRET_STRING = 'your-bucket-name';

CREATE OR REPLACE SECRET aws_region
  TYPE = GENERIC_STRING
  SECRET_STRING = 'us-east-1';

-- Certificate Private Key (multi-line secret)
-- Note: Replace newlines in your PEM file with \n before pasting
CREATE OR REPLACE SECRET sharepoint_cert_key
  TYPE = GENERIC_STRING
  SECRET_STRING = '-----BEGIN PRIVATE KEY-----\nYOUR_KEY_CONTENT_HERE\n-----END PRIVATE KEY-----';

-- Step 6: Create Compute Pool
-- ============================================================================
-- Adjust instance family and size based on your needs
CREATE COMPUTE POOL IF NOT EXISTS SHAREPOINT_SYNC_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE;

-- Check compute pool status
SHOW COMPUTE POOLS;
DESC COMPUTE POOL SHAREPOINT_SYNC_POOL;

-- Step 7: Create Stage for Certificate File (Alternative to inline secret)
-- ============================================================================
-- This is an alternative approach if you prefer to mount the cert as a file
CREATE OR REPLACE STAGE cert_stage
  DIRECTORY = (ENABLE = TRUE)
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');

-- Upload certificate file to stage
-- (Use SnowSQL or Snowsight to upload sharepoint-worker.key to @cert_stage)
-- PUT file:///path/to/sharepoint-worker.key @cert_stage AUTO_COMPRESS=FALSE;

-- Step 8: Create Service Specification
-- ============================================================================
CREATE SERVICE IF NOT EXISTS sharepoint_sync_service
  IN COMPUTE POOL SHAREPOINT_SYNC_POOL
  FROM SPECIFICATION $$
    spec:
      containers:
      - name: sharepoint-worker
        image: /sharepoint_sync_db/services/sharepoint_sync_repo/sharepoint-sync-worker:latest
        env:
          CERT_PRIVATE_KEY_PATH: /tmp/sharepoint-worker.key
          S3_PREFIX: sharepoint-data/
          POLL_INTERVAL_SECONDS: "300"
          RUN_ONCE: "false"
          SKIP_UNCHANGED: "true"
        secrets:
        - snowflakeSecret:
            objectName: azure_tenant_id
          envVarName: TENANT_ID
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: azure_client_id
          envVarName: CLIENT_ID
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: sharepoint_site_url
          envVarName: SITE_URL
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: sharepoint_list_name
          envVarName: LIST_NAME
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: azure_cert_thumbprint
          envVarName: CERT_THUMBPRINT
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: sharepoint_cert_key
          envVarName: CERT_PRIVATE_KEY
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: aws_s3_bucket
          envVarName: S3_BUCKET
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: aws_region
          envVarName: AWS_REGION
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: aws_access_key_id
          envVarName: AWS_ACCESS_KEY_ID
          secretKeyRef: secret_string
        - snowflakeSecret:
            objectName: aws_secret_access_key
          envVarName: AWS_SECRET_ACCESS_KEY
          secretKeyRef: secret_string
        command:
        - /bin/sh
        - -c
        - |
          echo "$CERT_PRIVATE_KEY" > /tmp/sharepoint-worker.key && \
          chmod 600 /tmp/sharepoint-worker.key && \
          node src/index.js
        resources:
          requests:
            cpu: 1
            memory: 2Gi
          limits:
            cpu: 2
            memory: 4Gi
  $$
  EXTERNAL_ACCESS_INTEGRATIONS = (sharepoint_sync_external_access)
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1
  AUTO_RESUME = TRUE;


-- Step 9: Monitor Service
-- ============================================================================

-- Check service status
SHOW SERVICES IN SCHEMA SERVICES;
DESC SERVICE sharepoint_sync_service;

-- Get service details and logs
CALL SYSTEM$GET_SERVICE_STATUS('sharepoint_sync_service');

-- View service logs (replace container_name with actual name from above)
CALL SYSTEM$GET_SERVICE_LOGS('sharepoint_sync_service', '0', 'sharepoint-worker', 100);

-- Check if service is ready
SELECT SYSTEM$GET_SERVICE_STATUS('sharepoint_sync_service');

-- Step 10: Manage Service
-- ============================================================================

-- Suspend service
-- ALTER SERVICE sharepoint_sync_service SUSPEND;

-- Resume service
-- ALTER SERVICE sharepoint_sync_service RESUME;

-- Update service (after pushing new image)
-- ALTER SERVICE sharepoint_sync_service FROM SPECIFICATION '...'

-- Drop service (if needed)
-- DROP SERVICE sharepoint_sync_service;

-- Drop compute pool (if needed, after dropping service)
-- DROP COMPUTE POOL SHAREPOINT_SYNC_POOL;
