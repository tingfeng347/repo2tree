export async function loadItem(key: string): Promise<string> {
  const res = await fetch(`/api/items/${key}`)
  if (!res.ok) {
    throw new Error("not found")
  }
  return res.text()
}

export async function saveItem(key: string, value: string) {
  return fetch(`/api/items/${key}`, { method: "POST", body: value })
}

export function Panel(props: { keys: string[] }) {
  const onClick = () => saveItem("a", "b")
  return props.keys.length > 0 ? props.keys.map((k) => loadItem(k)) : onClick
}
