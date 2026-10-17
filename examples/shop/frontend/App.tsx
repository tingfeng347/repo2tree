// Static teaching fixture: event registration is separate from event activation.
type Props = { sku: string; quantity: number }

export async function submitOrder(sku: string, quantity: number) {
  const response = await fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ sku, quantity }),
  })
  if (!response.ok) {
    showError('The order could not be created')
    return null
  }
  return response.json()
}

export function showError(message: string) {
  console.error(message)
}

export async function loadStock(sku: string) {
  const response = await fetch(`/api/stock/${sku}`)
  return response.json()
}

export function OrderPage(props: Props) {
  const onSubmit = () => submitOrder(props.sku, props.quantity)
  return <main>
    <h1>Order a book</h1>
    <button onClick={onSubmit}>Create order</button>
    {props.quantity > 10 && <p>Maximum ten units</p>}
  </main>
}
