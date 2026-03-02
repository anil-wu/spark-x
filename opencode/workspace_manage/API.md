# workspace_manage API

Base URL: `http://<host>:7070`

## Health

### GET /health

#### Response 200

```json
{ "ok": true }
```

## Projects

### POST /api/projects/create

Create a project directory and write user info file.

#### Body

```json
{
  "userId": "u_demo",
  "projectId": "p_demo",
  "token": "123456"
}
```

Constraints:

- `userId`: `[a-zA-Z0-9_-]{1,64}`
- `projectId`: `[a-zA-Z0-9_-]{1,64}`

#### Behavior

- Base directory is `OPENCODE_WORKSPACE_DIR` (fallback `WORKSPACE_DIR`, else current working directory)
- Creates directory: `{baseDir}/{userId}/{projectId}`
- Writes file: `{baseDir}/{userId}/{projectId}/userinfo_{userId}.json`

`userinfo_{userId}.json` content:

```json
{
  "userId": "u_demo",
  "projectId": "p_demo",
  "token": "123456"
}
```

#### Response 200

```json
{
  "ok": true,
  "created": true,
  "path": "/workspace/u_demo/p_demo",
  "userinfoPath": "/workspace/u_demo/p_demo/userinfo_u_demo.json"
}
```

Notes:

- `created=false` if the project directory already exists.

#### Response 400

```json
{ "ok": false, "error": "userId is required" }
```
