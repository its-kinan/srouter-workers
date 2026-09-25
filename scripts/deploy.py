#!/usr/bin/env python3
"""Deploy srouter-workers to Cloudflare via the raw REST API.

Steps:
  1. node scripts/inline-dashboard.mjs  (real SRouter index.html -> src/dashboard-html.ts)
  2. esbuild bundle src/index.ts -> worker.mjs
  3. Upload web-dist/ as Workers Static Assets -> completion JWT
  4. PUT worker script with bindings + assets JWT

Auth: uses the stored custom.cloudflare credential via dynamic_credentials.
Run: python3 scripts/deploy.py
"""
import base64
import hashlib
import json
import mimetypes
import os
import secrets as pysecrets
import subprocess
import sys
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = "srouter-workers"
ESBUILD = "/usr/lib/node_modules/wrangler/node_modules/@esbuild/linux-x64/bin/esbuild"
D1_ID = "33de2eec-bd48-4bae-a491-65f2bba1c0f9"
R2_BUCKET = "srouter-data"
HOSTS = ["api.cloudflare.com"]


def api(method, path, payload=None, raw_body=None, content_type=None, bearer=None):
    url = path if path.startswith("https://") else BASE + path
    data = raw_body if raw_body is not None else (
        json.dumps(payload).encode() if payload is not None else None)
    headers = {"Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    elif payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    else:
        add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=HOSTS)
    return read_json_response(urllib.request.urlopen(req, timeout=180))


def multipart(parts):
    boundary = "----cfdeploy" + pysecrets.token_hex(8)
    body = b""
    for name, filename, ctype, data in parts:
        disp = f'form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        body += (f"--{boundary}\r\nContent-Disposition: {disp}\r\n"
                 f"Content-Type: {ctype}\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def main():
    global BASE
    acct = api("GET", "https://api.cloudflare.com/client/v4/accounts")["result"][0]["id"]
    BASE = f"https://api.cloudflare.com/client/v4/accounts/{acct}"

    # 1. inline dashboard shell
    subprocess.run(["node", "scripts/inline-dashboard.mjs"], cwd=ROOT, check=True)

    # 2. bundle
    worker_js = os.path.join(ROOT, "worker.mjs")
    subprocess.run([
        ESBUILD, "src/index.ts", "--bundle", "--format=esm",
        "--platform=browser", "--target=es2022", "--minify",
        f"--outfile={worker_js}",
    ], cwd=ROOT, check=True)
    size = os.path.getsize(worker_js)
    print(f"bundled worker.mjs ({size} bytes)")

    # 3. assets manifest from web-dist/
    dist = os.path.join(ROOT, "web-dist")
    manifest, blobs = {}, {}
    for root, _, files in os.walk(dist):
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = "/" + os.path.relpath(p, dist).replace(os.sep, "/")
            with open(p, "rb") as fh:
                content = fh.read()
            h = hashlib.sha256(
                base64.b64encode(content) + os.path.splitext(f)[1].encode()
            ).hexdigest()[:32]
            manifest[rel] = {"hash": h, "size": len(content)}
            blobs[h] = (rel, content)
    print(f"manifest: {len(manifest)} files")

    sess = api("POST", f"/workers/scripts/{SCRIPT}/assets-upload-session",
               {"manifest": manifest})
    if not sess.get("success"):
        print("SESSION FAILED:", json.dumps(sess)[:500])
        sys.exit(1)
    sess_jwt = sess["result"]["jwt"]
    buckets = sess["result"]["buckets"] or []
    print(f"session ok, {len(buckets)} buckets to upload")

    completion_jwt = sess_jwt
    for i, bucket in enumerate(buckets):
        parts = []
        for h in bucket:
            rel, content = blobs[h]
            ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
            parts.append((h, os.path.basename(rel), ctype,
                          base64.b64encode(content)))
        body, ctype = multipart(parts)
        r = api("POST", "/workers/assets/upload?base64=true",
                raw_body=body, content_type=ctype, bearer=sess_jwt)
        if not r.get("success"):
            print("BUCKET FAILED:", json.dumps(r)[:500])
            sys.exit(1)
        if r["result"].get("jwt"):
            completion_jwt = r["result"]["jwt"]
        print(f"bucket {i+1}/{len(buckets)} ok")

    # 4. upload worker script
    with open(worker_js, "rb") as fh:
        worker_code = fh.read()
    metadata = {
        "main_module": "worker.mjs",
        "compatibility_date": "2026-09-01",
        "compatibility_flags": ["nodejs_compat"],
        "observability": {"enabled": True},
        "bindings": [
            {"type": "d1", "name": "DB", "id": D1_ID},
            {"type": "r2_bucket", "name": "R2", "bucket_name": R2_BUCKET},
            {"type": "durable_object_namespace", "name": "ROUTER_STATE",
             "class_name": "RouterState"},
            {"type": "assets", "name": "ASSETS"},
            {"type": "plain_text", "name": "ENVIRONMENT", "text": "production"},
        ],
        # NOTE: no `migrations` — the RouterState migration (tag v1) is already
        # applied; re-sending it fails with 10074.
        "assets": {"jwt": completion_jwt},
    }
    body, ctype = multipart([
        ("metadata", None, "application/json", json.dumps(metadata).encode()),
        ("worker.mjs", "worker.mjs", "application/javascript+module", worker_code),
    ])
    r = api("PUT", f"/workers/scripts/{SCRIPT}", raw_body=body, content_type=ctype)
    if not r.get("success"):
        print("DEPLOY FAILED:", json.dumps(r)[:800])
        sys.exit(1)
    print("deployed:", r["result"]["id"])


if __name__ == "__main__":
    main()
