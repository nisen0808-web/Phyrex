# Database Check API

## Endpoint

```text
GET /admin/database/check
```

## Parameters

```text
dbProvider=jsonl
dbDir=world-engine/data/db
dbName=world-engine
```

## Example

```text
/admin/database/check?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Output

```text
version
config
supported
ok
counts
files
warnings
errors
```

## Test

```text
database-admin-status-test.js
```
