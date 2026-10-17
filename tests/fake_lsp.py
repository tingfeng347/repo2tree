"""Protocol fixture, not a production language server. Exchanges framed JSON-RPC."""
import json
import sys

def send(value):
    body = json.dumps(value).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()

while True:
    length = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit()
        if line.strip() == b"":
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":")[1])
    value = json.loads(sys.stdin.buffer.read(length))
    method = value.get("method")
    if "id" not in value:
        if method == "exit":
            break
        continue
    if method == "initialize":
        result = {"capabilities": {"callHierarchyProvider": True}}
    elif method == "textDocument/prepareCallHierarchy":
        line = value["params"]["position"]["line"]
        result = [{"name": "caller" if line == 0 else "callee", "uri": value["params"]["textDocument"]["uri"], "kind": 12,
                   "range": {"start": {"line": line, "character": 0}, "end": {"line": line+1, "character": 10}},
                   "selectionRange": {"start": {"line": line, "character": 4}, "end": {"line": line, "character": 10}}}]
    elif method == "callHierarchy/outgoingCalls":
        item = value["params"]["item"]
        if item["name"] == "caller":
            target = {**item, "name": "callee", "selectionRange": {"start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 10}}}
            result = [{"to": target, "fromRanges": [{"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 10}}]}]
        else:
            result = []
    else:
        result = None
    send({"jsonrpc": "2.0", "id": value["id"], "result": result})
